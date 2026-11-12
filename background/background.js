/**
 * background.js — Service Worker (Manifest V3).
 *
 * Responsibilities:
 *   1. Persist configuration (servers, settings, history) in chrome.storage.local.
 *   2. Maintain a WebSocket connection ONLY to enabled MCP servers.
 *   3. Expose a message API to the popup and content scripts (see `handleMessage`).
 *
 * Fork additions:
 *   - Per-host enable map: each AI site can be toggled independently.
 *   - Default permission for new MCPs is "Always allow" so injection works out of the box.
 */
import { McpConnection } from './ws_client.js';
import {
  STORAGE_KEYS as KEYS, LEGACY_STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_PERMISSION, MAX_ACTIVE_SERVERS,
  CALL_TIMEOUT_MS, HISTORY_LIMIT, SUPPORTED_URL_PATTERNS, SUPPORTED_HOSTS, PERMISSIONS, RESPONSE_DELAY_MAX_MS,
  NOTICES_URL, NOTICES_EVERY_MS, NOTICES_RETRY_MS, NOTICES_MAX_BYTES,
  DEFAULT_CONTROL_PORT, DEFAULT_LAUNCHER_PORT,
} from '../shared/constants.js';
import { compareVersions, normalizeFeed, publicNotices, mergeFeed, safeLink } from './notices.js';

/** @type {Map<string, McpConnection>} serverId → connection */
const connections = new Map();

// Serialize storage mutations to avoid races.
let lock = Promise.resolve();
const withLock = (fn) => {
  const run = lock.then(() => fn());
  lock = run.catch(() => {});
  return run;
};

// ───────────────────────── State and storage ─────────────────────────

async function loadState() {
  const data = await chrome.storage.local.get([KEYS.servers, KEYS.settings]);
  const stored = data[KEYS.settings] ?? {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  settings.hostEnabled = { ...DEFAULT_SETTINGS.hostEnabled, ...(stored.hostEnabled ?? {}) };
  for (const host of SUPPORTED_HOSTS) {
    if (!(host in settings.hostEnabled)) settings.hostEnabled[host] = true;
    settings.hostEnabled[host] = settings.hostEnabled[host] !== false;
  }
  delete settings.checkUpdates;
  if (!PERMISSIONS.includes(settings.defaultPermission)) {
    // Legacy migrations: `autoExecute: false` means the user explicitly wanted to be asked.
    settings.defaultPermission = stored.autoExecute === false ? 'ask' : DEFAULT_PERMISSION;
  }
  const servers = (data[KEYS.servers] ?? []).filter((s) => s.url).map((s) => ({
    ...s,
    permission: PERMISSIONS.includes(s.permission) ? s.permission : settings.defaultPermission,
  }));
  return { servers, settings };
}

const isUsable = (s) => s.enabled && s.url && s.permission !== 'deny';

const saveServers = (servers) => chrome.storage.local.set({ [KEYS.servers]: servers });

function assignSlugs(servers) {
  const used = new Set();
  const slugs = new Map();
  for (const s of [...servers].sort((a, b) => Boolean(b.url) - Boolean(a.url))) {
    const base = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = `${base}_${n}`;
    used.add(slug);
    slugs.set(s.id, slug);
  }
  return slugs;
}

/**
 * Extract the host of the tab that sent the message.
 * Returns null when the sender is not a tab (popup, worker, etc.) — in that case
 * host checks are skipped, since the popup only aggregates data.
 */
function senderHost(sender) {
  const url = sender?.tab?.url;
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SUPPORTED_HOSTS.includes(host) ? host : null;
  } catch { return null; }
}

// ───────────────────────── Connections ─────────────────────────

let lastDiscovery = 0;

const bridge = {
  checked: false, online: false, version: null, pid: null, config: null, configError: null,
  supervised: false, startedAt: null, servers: [], error: null, launcherOnline: false, paused: false,
};
let lastProbe = 0;
let probing = null;
let storedConfig = null;
chrome.storage.local.get(KEYS.bridge).then((data) => {
  storedConfig = data[KEYS.bridge]?.config ?? null;
  if (!bridge.config) bridge.config = storedConfig;
}).catch(() => {});

async function bridgeFetch(path, { method = 'GET', timeout = 1500, body: payload } = {}) {
  const { settings } = await loadState();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const extra = payload === undefined ? {} : { body: payload, headers: { 'Content-Type': 'text/plain; charset=utf-8' } };
    const res = await fetch(`http://127.0.0.1:${settings.controlPort || DEFAULT_CONTROL_PORT}${path}`, { method, cache: 'no-store', signal: ctl.signal, ...extra });
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

function probeBridge(force = false) {
  if (!force && Date.now() - lastProbe < 2500) return Promise.resolve(bridge);
  if (probing) return probing;
  probing = (async () => {
    const launcherProbe = probeLauncher();
    try {
      const { status, body } = await bridgeFetch('/servers');
      if (status !== 200 || !body?.ok) throw new Error('Unexpected bridge response.');
      Object.assign(bridge, {
        checked: true, online: true, version: body.version ?? null, pid: body.pid ?? null, config: body.config ?? bridge.config,
        configError: body.config_error ?? null, supervised: Boolean(body.supervised), startedAt: body.started_at ?? null,
        servers: Array.isArray(body.servers) ? body.servers : [], error: null,
      });
      if (body.config && body.config !== storedConfig) {
        storedConfig = body.config;
        chrome.storage.local.set({ [KEYS.bridge]: { config: body.config } }).catch(() => {});
      }
    } catch (err) {
      Object.assign(bridge, {
        checked: true, online: false, pid: null, configError: null, servers: [],
        error: err?.name === 'AbortError' ? 'no response' : (err?.message ?? 'not connected'),
      });
    }
    await launcherProbe;
    lastProbe = Date.now();
    return bridge;
  })().finally(() => { probing = null; });
  return probing;
}
const portOf = (u) => { try { return new URL(u).port; } catch { return ''; } };
const isLocalUrl = (u) => { try { return ['localhost', '127.0.0.1'].includes(new URL(u).hostname); } catch { return false; } };
const safeUrl = (raw) => { try { return validateUrl(String(raw)); } catch { return null; } };

async function discoverServers(force = false) {
  const { settings } = await loadState();
  if (settings.autoDiscover === false) return { ok: true, skipped: true };
  if (!force && Date.now() - lastDiscovery < 8000) return { ok: true, throttled: true };
  lastDiscovery = Date.now();

  const info = await probeBridge(true);
  if (!info.online) return { ok: false, error: 'Bridge not found. Start it with server/start_bridge_loop.pyw.' };

  const list = (Array.isArray(info.servers) ? info.servers : [])
    .map((s) => ({ name: String(s?.name ?? '').trim(), url: safeUrl(s?.url) }))
    .filter((s) => s.name && s.url);
  const listed = new Set(list.map((s) => s.url));

  return withLock(async () => {
    const { servers, settings: cfg } = await loadState();
    const store = await chrome.storage.local.get(KEYS.dismissed);
    const dismissed = (store[KEYS.dismissed] ?? []).filter((u) => listed.has(u));
    let changed = false;
    let added = 0;

    for (const s of list) {
      if (dismissed.includes(s.url)) continue;
      const existing = servers.find((x) => x.url === s.url || (isLocalUrl(x.url) && portOf(x.url) === portOf(s.url)));
      if (existing) {
        if (existing.auto && !existing.renamed && existing.name !== s.name) { existing.name = s.name; changed = true; }
        continue;
      }
      const active = servers.filter((x) => x.enabled).length;
      const enable = cfg.autoEnableDiscovered ? active < MAX_ACTIVE_SERVERS : active === 0;
      servers.push({ id: crypto.randomUUID(), name: s.name, url: s.url, enabled: enable, permission: cfg.defaultPermission, auto: true });
      changed = true;
      added += 1;
    }
    const kept = servers.filter((x) => !(x.auto && !listed.has(x.url)));
    if (kept.length !== servers.length) changed = true;
    if (dismissed.length !== (store[KEYS.dismissed] ?? []).length) await chrome.storage.local.set({ [KEYS.dismissed]: dismissed });
    if (changed) { await saveServers(kept); await reconcile(); scheduleBroadcast(); }
    return { ok: true, changed, added, total: list.length };
  });
}

let broadcastTimer = null;
function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_URL_PATTERNS });
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'STATE_CHANGED' }).catch(() => {});
  }, 300);
}

function onConnectionChange(evt) {
  if (evt.kind === 'tools' || evt.prev === 'connected' || evt.next === 'connected') scheduleBroadcast();
}

async function updateBadge(enabled) {
  let unread = 0;
  try { unread = (await readNotices()).unread; } catch { /* no stored notices */ }
  await chrome.action.setBadgeText({ text: !enabled ? 'OFF' : (unread ? (unread > 9 ? '9+' : String(unread)) : '') });
  await chrome.action.setBadgeBackgroundColor({ color: !enabled ? '#8a8078' : '#c9803a' });
}
async function reconcile() {
  const { servers, settings } = await loadState();
  updateBadge(settings.bridgeEnabled).catch(() => {});
  const wanted = new Map((settings.bridgeEnabled ? servers : []).filter(isUsable).slice(0, MAX_ACTIVE_SERVERS).map((s) => [s.id, s]));

  for (const [id, conn] of connections) {
    const target = wanted.get(id);
    if (!target || target.url !== conn.server.url) {
      conn.close();
      connections.delete(id);
    }
  }
  for (const [id, server] of wanted) {
    const existing = connections.get(id);
    if (existing) {
      existing.server = server;
    } else {
      const conn = new McpConnection(server, onConnectionChange);
      connections.set(id, conn);
      conn.connect();
    }
  }
}

// ───────────────────────── Queries ─────────────────────────

async function getSnapshot() {
  discoverServers().catch(() => {});
  probeBridge().catch(() => {});
  const { servers, settings } = await loadState();
  const slugs = assignSlugs(servers);
  return {
    ok: true,
    settings,
    version: localVersion(),
    notices: await readNotices(),
    bridge: publicBridge(),
    max: MAX_ACTIVE_SERVERS,
    servers: servers.map((s) => {
      const conn = connections.get(s.id);
      const live = bridge.servers.find((b) => b.url === s.url || (isLocalUrl(s.url) && portOf(b.url) === portOf(s.url)));
      return {
        ...s,
        bridgeStatus: live?.status ?? null,
        bridgeError: live?.error ?? null,
        slug: slugs.get(s.id),
        status: conn?.status ?? 'disconnected',
        error: conn?.lastError ?? null,
        toolCount: conn?.tools.length ?? 0,
        approxTokens: conn ? Math.ceil(JSON.stringify(conn.tools).length / 4) : 0,
      };
    }),
  };
}

async function getActiveTools(sender) {
  await discoverServers().catch(() => {});
  await reconcile();
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: true, tools: [], disabled: true, reason: 'global' };

  const host = senderHost(sender);
  if (host && settings.hostEnabled?.[host] === false) {
    return { ok: true, tools: [], disabled: true, reason: 'host', host };
  }

  const slugs = assignSlugs(servers);
  const active = servers.filter(isUsable);
  await Promise.all(active.map((s) => connections.get(s.id)?.whenReady(4000)));

  const tools = [];
  for (const s of active) {
    for (const t of connections.get(s.id)?.tools ?? []) {
      tools.push({
        server: slugs.get(s.id),
        serverLabel: s.name,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  return { ok: true, tools };
}

async function addHistory(entry) {
  return withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.history);
    const history = [entry, ...(data[KEYS.history] ?? [])].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [KEYS.history]: history });
  });
}

async function callTool({ server, name, arguments: args }, sender) {
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: false, error: 'The bridge is disabled.' };
  const host = senderHost(sender);
  if (host && settings.hostEnabled?.[host] === false) return { ok: false, error: `The bridge is disabled for ${host}.` };
  const slugs = assignSlugs(servers);
  const active = servers.filter((s) => s.enabled && s.url);
  const target = server
    ? active.find((s) => slugs.get(s.id) === server || s.name === server || s.id === server)
    : (active.length === 1 ? active[0] : null);

  const label = target ? slugs.get(target.id) : (server ?? '?');
  const entry = { ts: Date.now(), server: label, tool: name, args: JSON.stringify(args ?? {}).slice(0, 300) };
  const fail = async (error) => {
    await addHistory({ ...entry, status: 'error', error });
    return { ok: false, error };
  };

  if (!target) return fail(`Server "${label}" is not active.`);
  if (target.permission === 'deny') return fail(`The user does not allow "${label}".`);
  const conn = connections.get(target.id);
  if (conn && conn.status !== 'connected') conn.connect();
  if (!conn || !(await conn.whenReady(10_000))) return fail(`Server "${label}" is not connected.`);
  if (!conn.tools.some((t) => t.name === name)) return fail(`Tool "${name}" does not exist on "${label}".`);

  const started = Date.now();
  try {
    const result = await conn.callTool(name, args, CALL_TIMEOUT_MS);
    await addHistory({ ...entry, status: result?.isError ? 'error' : 'ok', ms: Date.now() - started });
    return { ok: true, result };
  } catch (err) {
    await addHistory({ ...entry, status: 'error', error: err.message, ms: Date.now() - started });
    return { ok: false, error: err.message };
  }
}

// ───────────────────────── Mutations (from popup) ─────────────────────────

function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('URL must start with ws:// or wss://');
  return url.toString().replace(/\/$/, '');
}

const mutate = (fn) => withLock(async () => {
  const { servers, settings } = await loadState();
  const result = await fn(servers, settings);
  await reconcile();
  scheduleBroadcast();
  return result ?? { ok: true };
});

const mutations = {
  ADD_SERVER: ({ name, url }) => mutate(async (servers, settings) => {
    const cleanUrl = validateUrl(String(url ?? '').trim());
    const cleanName = String(name ?? '').trim() || 'mcp';
    if (servers.some((s) => s.url === cleanUrl)) throw new Error('That URL is already registered.');
    servers.push({
      id: crypto.randomUUID(), name: cleanName, url: cleanUrl, enabled: servers.every((s) => !s.enabled), permission: settings.defaultPermission,
    });
    await saveServers(servers);
  }),

  SET_PERMISSION: ({ id, permission }) => mutate(async (servers) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Invalid permission.');
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Server not found.');
    server.permission = permission;
    await saveServers(servers);
  }),

  SET_ALL_PERMISSIONS: ({ permission }) => mutate(async (servers, settings) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Invalid permission.');
    servers.forEach((s) => { s.permission = permission; });
    await saveServers(servers);
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, defaultPermission: permission } });
  }),

  REMOVE_SERVER: ({ id }) => mutate(async (servers) => {
    const gone = servers.find((s) => s.id === id);
    if (gone?.auto) {
      const store = await chrome.storage.local.get(KEYS.dismissed);
      await chrome.storage.local.set({ [KEYS.dismissed]: [...new Set([...(store[KEYS.dismissed] ?? []), gone.url])] });
    }
    await saveServers(servers.filter((s) => s.id !== id));
  }),

  RENAME_SERVER: ({ id, name }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Server not found.');
    server.name = String(name ?? '').trim() || server.name;
    server.renamed = true;
    await saveServers(servers);
  }),

  TOGGLE_SERVER: ({ id, enabled }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Server not found.');
    if (enabled && servers.filter((s) => s.enabled && s.id !== id).length >= MAX_ACTIVE_SERVERS) {
      throw new Error(`Only ${MAX_ACTIVE_SERVERS} MCP servers can be active at once.`);
    }
    server.enabled = Boolean(enabled);
    await saveServers(servers);
  }),

  UPDATE_SETTINGS: ({ settings: patch }) => mutate(async (_servers, settings) => {
    const clean = { ...patch };
    if ('responseDelayMs' in clean) {
      clean.responseDelayMs = Math.min(RESPONSE_DELAY_MAX_MS, Math.max(0, Math.round(Number(clean.responseDelayMs)) || 0));
    }
    if (clean.hostEnabled) {
      const merged = { ...settings.hostEnabled };
      for (const [host, value] of Object.entries(clean.hostEnabled)) {
        if (!SUPPORTED_HOSTS.includes(host)) continue;
        merged[host] = value !== false;
      }
      clean.hostEnabled = merged;
    }
    if ('bridgeEnabled' in clean && clean.bridgeEnabled !== settings.bridgeEnabled) {
      if (clean.bridgeEnabled) {
        if (globalThis.wmbxNative && globalThis.wmbxNative.isAvailable()) globalThis.wmbxNative.start();
      } else {
        if (globalThis.wmbxNative && globalThis.wmbxNative.isAvailable()) globalThis.wmbxNative.stop();
      }
    }
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, ...clean } });
  }),

  UPDATE_HOST_ENABLED: ({ host, enabled }) => mutate(async (_servers, settings) => {
    if (!SUPPORTED_HOSTS.includes(host)) throw new Error('Unsupported host.');
    const hostEnabled = { ...settings.hostEnabled, [host]: enabled !== false };
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, hostEnabled } });
  }),
};

// ───────────────────────── Message router ─────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)));

async function focusTab(sender) {
  const tab = sender?.tab;
  if (!tab?.id) return { ok: false, error: 'No tab.' };
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const prev = previous && previous.id !== tab.id ? { tabId: previous.id, windowId: previous.windowId } : null;
  return { ok: true, prev };
}

async function restoreFocus({ prev }) {
  if (!prev) return { ok: true };
  await chrome.tabs.update(prev.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(prev.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

const localVersion = () => chrome.runtime.getManifest?.().version ?? '0.0.0';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bridgeCanControl = () => bridge.online && (compareVersions(bridge.version, '1.4.0') ?? -1) >= 0;

function publicBridge() {
  const { servers: _servers, ...rest } = bridge;
  return { ...rest, canControl: bridgeCanControl() };
}

const OLD_BRIDGE = 'Your bridge is older and does not support this action. Close it and open it once with server/restart_bridge.cmd; the button will work afterwards.';

async function launcherFetch(path, { method = 'GET', timeout = 1500 } = {}) {
  const { settings } = await loadState();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${settings.launcherPort || DEFAULT_LAUNCHER_PORT}${path}`, { method, cache: 'no-store', signal: ctl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

async function probeLauncher() {
  try {
    const { status, body } = await launcherFetch('/status', { timeout: 5000 });
    bridge.launcherOnline = status === 200 && Boolean(body?.launcher);
    bridge.paused = bridge.launcherOnline && Boolean(body?.paused);
  } catch {
    bridge.launcherOnline = false;
    bridge.paused = false;
  }
}

const NO_LAUNCHER = 'Launcher missing: double-click server/install.cmd once, then you can start, stop, and restart the bridge from here.';

async function controlBridge(action) {
  const before = await probeBridge(true);
  if (!before.launcherOnline) return { ok: false, noLauncher: true, error: NO_LAUNCHER };
  const oldPid = before.online ? before.pid : null;
  try {
    const { status, body } = await launcherFetch(`/${action}`, { method: 'POST', timeout: 5000 });
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'The launcher rejected the command.' };
  } catch {
    return { ok: false, error: 'Could not reach the launcher.' };
  }
  const wantOnline = action !== 'stop';
  const end = Date.now() + (wantOnline ? 30_000 : 15_000);
  while (Date.now() < end) {
    await delay(700);
    const probe = await probeBridge(true);
    if (!wantOnline) {
      if (!probe.online) { scheduleBroadcast(); return { ok: true, stopped: true }; }
    } else if (probe.online && (action !== 'restart' || oldPid === null || probe.pid !== oldPid)) {
      for (const conn of connections.values()) conn.connect();
      await discoverServers(true).catch(() => {});
      scheduleBroadcast();
      return { ok: true, pid: probe.pid, supervised: probe.supervised, configError: probe.configError };
    }
  }
  return {
    ok: false,
    error: wantOnline ? 'The bridge did not come back online within 30 seconds. Check server/bridge.log.' : 'The bridge did not stop within 15 seconds.',
  };
}
async function restartBridge() {
  const before = await probeBridge(true);
  if (before.launcherOnline) return controlBridge('restart');
  if (!before.online) {
    return { ok: false, error: 'The bridge is not running, so there is nothing to restart from here. Start it with server/start_bridge_loop.pyw.' };
  }
  if (!bridgeCanControl()) return { ok: false, error: OLD_BRIDGE };
  const oldPid = before.pid;
  try {
    const { status, body } = await bridgeFetch('/restart', { method: 'POST', timeout: 4000 });
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'The bridge did not accept the restart.' };
  } catch {
    return { ok: false, error: 'Could not reach the bridge.' };
  }
  const end = Date.now() + 30_000;
  let after = null;
  while (Date.now() < end) {
    await delay(700);
    const probe = await probeBridge(true);
    if (probe.online && probe.pid !== oldPid) { after = probe; break; }
  }
  if (!after) return { ok: false, error: 'The bridge did not come back online within 30 seconds. Check server/bridge.log or start it with start_bridge_loop.pyw.' };
  for (const conn of connections.values()) conn.connect();
  await discoverServers(true).catch(() => {});
  scheduleBroadcast();
  return { ok: true, pid: after.pid, supervised: after.supervised, configError: after.configError };
}

async function stopViaControlPort() {
  const before = await probeBridge(true);
  if (!before.online) return { ok: true, stopped: true, already: true };
  try { await bridgeFetch('/shutdown', { method: 'POST', timeout: 4000 }); } catch { /* already closing */ }
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    await delay(600);
    if (!(await probeBridge(true)).online) { scheduleBroadcast(); return { ok: true, stopped: true }; }
  }
  return { ok: false, error: 'The bridge did not stop within 15 seconds.' };
}

async function bridgeGlobal(action) {
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: 'Invalid action.' };
  await withLock(async () => {
    const { settings } = await loadState();
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, bridgeEnabled: action !== 'stop' } });
  });
  await reconcile();
  scheduleBroadcast();

  if (globalThis.wmbxNative && globalThis.wmbxNative.isAvailable()) {
    try {
      if (action === 'stop') globalThis.wmbxNative.stop();
      else if (action === 'start') globalThis.wmbxNative.start();
      else if (action === 'restart') globalThis.wmbxNative.restart();
      await delay(1500);
      await probeBridge(true);
      scheduleBroadcast();
      return { ok: true, native: true };
    } catch (err) {
      console.warn('[WMB] native control failed, falling back to HTTP:', err);
    }
  }

  const before = await probeBridge(true);
  let res;
  if (action === 'stop') {
    res = before.launcherOnline ? await controlBridge('stop') : await stopViaControlPort();
    if (!res.ok && before.online) res = await stopViaControlPort();
  } else if (action === 'start') {
    if (before.launcherOnline) res = await controlBridge('start');
    else if (before.online) res = { ok: true, already: true, pid: before.pid };
    else res = { ok: false, noLauncher: true, error: NO_LAUNCHER };
  } else if (before.launcherOnline || before.online) {
    res = await restartBridge();
  } else {
    res = { ok: false, noLauncher: true, error: NO_LAUNCHER };
  }
  await probeBridge(true);
  scheduleBroadcast();
  return res;
}

const OLD_BRIDGE_CONFIG = 'Your bridge is older than 1.7.0 and cannot edit servers.json from here. Restart it with "Restart bridge" (or server/restart_bridge.cmd), then try again.';

async function getBridgeConfig() {
  const info = await probeBridge(true);
  if (!info.online) return { ok: false, offline: true, error: 'The bridge is off: turn it on to read servers.json.' };
  try {
    const { status, body } = await bridgeFetch('/config', { timeout: 5000 });
    if (status === 404) return { ok: false, oldBridge: true, error: OLD_BRIDGE_CONFIG };
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'Could not read servers.json.' };
    return { ok: true, ...body };
  } catch { return { ok: false, error: 'Could not reach the bridge.' }; }
}

async function saveBridgeConfig({ text }) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The content is empty.' };
  if (text.length > 1_000_000) return { ok: false, error: 'File is too large.' };
  const info = await probeBridge(true);
  if (!info.online) return { ok: false, offline: true, error: 'The bridge is off: turn it on to save. In the meantime you can download the file.' };
  try {
    const { status, body } = await bridgeFetch('/config', { method: 'POST', timeout: 15_000, body: text });
    if (status === 404) return { ok: false, oldBridge: true, error: OLD_BRIDGE_CONFIG };
    if (!body?.ok) return { ok: false, invalid: status === 400, error: body?.error ?? 'The bridge could not save the file.' };
    lastDiscovery = 0;
    await discoverServers(true).catch(() => {});
    scheduleBroadcast();
    return { ok: true, ...body };
  } catch { return { ok: false, error: 'Could not reach the bridge.' }; }
}

async function openConfig() {
  const info = await probeBridge(true);
  if (!info.online) {
    return { ok: false, offline: true, path: info.config, error: 'The bridge is off, so the file cannot be opened for you.' };
  }
  try {
    const { status, body } = await bridgeFetch('/open-config', { method: 'POST', timeout: 4000 });
    if (status === 404) return { ok: false, path: info.config, error: OLD_BRIDGE };
    if (status !== 200 || !body?.ok) return { ok: false, path: info.config, error: body?.error ?? 'Could not open the file.' };
    return { ok: true, path: body.path ?? info.config };
  } catch {
    return { ok: false, path: info.config, error: 'Could not reach the bridge.' };
  }
}

// ------------- Author notices -------------

const readNoticesRecord = async () => (await chrome.storage.local.get(KEYS.notices))[KEYS.notices] ?? null;
const readNotices = async () => publicNotices(await readNoticesRecord());

function notifyNotice(notice) {
  try {
    chrome.notifications?.create?.(`wmb-notice:${notice.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: notice.title,
      message: notice.message || 'Open Web MCP Bridge to see the details.',
      priority: notice.level === 'warning' ? 1 : 0,
    }, () => {
      if (chrome.runtime.lastError) console.warn('[WMB] notice notification not shown:', chrome.runtime.lastError.message);
    });
  } catch { /* no notification permission */ }
}

async function fetchNoticesFeed() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${NOTICES_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (new URL(res.url || NOTICES_URL).hostname !== new URL(NOTICES_URL).hostname) throw new Error('Response from an unexpected site.');
    const text = await res.text();
    if (text.length > NOTICES_MAX_BYTES) throw new Error('The notices file is too large.');
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

let noticesRun = null;
function checkNotices(force = false) {
  if (noticesRun) return noticesRun;
  noticesRun = runNoticesCheck(force).finally(() => { noticesRun = null; });
  return noticesRun;
}

async function failNotices(message) {
  await withLock(async () => {
    const prev = (await readNoticesRecord()) ?? { items: [], read: [], dismissed: [], notified: [] };
    await chrome.storage.local.set({ [KEYS.notices]: { ...prev, checkedAt: Date.now() - NOTICES_EVERY_MS + NOTICES_RETRY_MS, error: message } });
  });
  return { ok: false, error: message };
}

async function runNoticesCheck(force) {
  const { settings } = await loadState();
  if (!force && settings.showNotices === false) return { ok: true, skipped: true };
  if (!force) {
    const prev = await readNoticesRecord();
    if (Date.now() - (prev?.checkedAt ?? 0) < NOTICES_EVERY_MS) return { ok: true, throttled: true };
  }
  let feed;
  try {
    feed = await fetchNoticesFeed();
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'no response' : err instanceof SyntaxError ? 'the file is not valid JSON' : (err?.message ?? 'error');
    return failNotices(`Could not fetch notices (${reason}).`);
  }
  const parsed = normalizeFeed(feed, { version: localVersion() });
  if (!parsed.ok) return failNotices(parsed.error);

  const result = await withLock(async () => {
    const latest = await readNoticesRecord();
    const { record, toNotify } = mergeFeed(latest, parsed.items);
    await chrome.storage.local.set({ [KEYS.notices]: record });
    return { record, toNotify };
  });
  if (settings.showNotices !== false) result.toNotify.slice(0, 3).forEach(notifyNotice);
  await updateBadge(settings.bridgeEnabled).catch(() => {});
  return { ok: true, count: parsed.items.length, skipped: parsed.skipped, notices: publicNotices(result.record) };
}

async function markNoticesRead(ids, { dismiss = false } = {}) {
  await withLock(async () => {
    const rec = await readNoticesRecord();
    if (!rec) return;
    const targets = ids === 'all' ? rec.items.map((n) => n.id) : (Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    rec.read = [...new Set([...(rec.read ?? []), ...targets])];
    if (dismiss) rec.dismissed = [...new Set([...(rec.dismissed ?? []), ...targets])];
    await chrome.storage.local.set({ [KEYS.notices]: rec });
  });
  updateBadge((await loadState()).settings.bridgeEnabled).catch(() => {});
  return { ok: true, notices: await readNotices() };
}

chrome.notifications?.onClicked?.addListener(async (id) => {
  if (!String(id).startsWith('wmb-notice:')) return;
  const noticeId = String(id).slice('wmb-notice:'.length);
  const rec = await readNoticesRecord().catch(() => null);
  const link = safeLink(rec?.items?.find((n) => n.id === noticeId)?.url);
  if (link) chrome.tabs.create({ url: link });
  await markNoticesRead([noticeId]).catch(() => {});
  chrome.notifications.clear(id);
});

async function reinjectContentScripts() {
  if (!chrome.scripting?.executeScript) return;
  for (const cs of chrome.runtime.getManifest?.().content_scripts ?? []) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: cs.matches }); } catch { continue; }
    for (const tab of tabs) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js }); } catch { /* tab closed or no access */ }
    }
  }
}
async function handleMessage(msg, sender) {
  if (mutations[msg.type]) return mutations[msg.type](msg);
  switch (msg.type) {
    case 'SLEEP': await sleep(msg.ms); return { ok: true };
    case 'FOCUS_TAB': return focusTab(sender);
    case 'RESTORE_FOCUS': return restoreFocus(msg);
    case 'GET_STATE': return getSnapshot();
    case 'GET_ACTIVE_TOOLS': return getActiveTools(sender);
    case 'CALL_TOOL': return callTool(msg, sender);
    case 'DISCOVER':
      if (msg.reset) await chrome.storage.local.remove(KEYS.dismissed);
      return discoverServers(true);
    case 'GET_NOTICES': return { ok: true, notices: await readNotices() };
    case 'CHECK_NOTICES': return checkNotices(true);
    case 'READ_NOTICES': return markNoticesRead(msg.ids ?? 'all');
    case 'DISMISS_NOTICE': return markNoticesRead([msg.id], { dismiss: true });
    case 'RESTART_BRIDGE': return restartBridge();
    case 'START_BRIDGE': return bridgeGlobal('start');
    case 'STOP_BRIDGE': return bridgeGlobal('stop');
    case 'BRIDGE_GLOBAL': return bridgeGlobal(msg.action);
    case 'GET_CONFIG': return getBridgeConfig();
    case 'SAVE_CONFIG': return saveBridgeConfig(msg);
    case 'OPEN_CONFIG': return openConfig();
    case 'PROBE_BRIDGE': await probeBridge(true); return { ok: true, bridge: publicBridge() };
    case 'GET_HISTORY': {
      const data = await chrome.storage.local.get(KEYS.history);
      return { ok: true, history: data[KEYS.history] ?? [] };
    }
    case 'CLEAR_HISTORY':
      await chrome.storage.local.remove(KEYS.history);
      return { ok: true };
    case 'RECONNECT':
      connections.get(msg.id)?.close();
      connections.delete(msg.id);
      await reconcile();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
  return true;
});

// ───────────────────────── Lifecycle ─────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const { servers } = await loadState();
    await saveServers(servers);
    await chrome.storage.local.remove(LEGACY_STORAGE_KEYS).catch(() => {});
    await reconcile();
    if (details?.reason === 'install' || details?.reason === 'update') reinjectContentScripts().catch(() => {});
    if (details?.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
    checkNotices().catch(() => {});
  } catch (err) {
    console.warn('[WMB] onInstalled interrupted:', err?.message ?? err);
  }
});
chrome.alarms.create('wmbx-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wmbx-keepalive') { reconcile().catch(() => {}); discoverServers().catch(() => {}); checkNotices().catch(() => {}); }
});

reconcile().then(() => discoverServers(true)).catch((err) => console.error('[WMB] reconcile', err));
chrome.storage.local.remove(LEGACY_STORAGE_KEYS).catch(() => {});
checkNotices().catch(() => {});
