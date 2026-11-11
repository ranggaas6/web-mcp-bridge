/**
 * popup.js - Extension control panel.
 *
 * MCP servers are defined in server/servers.json (auto-detected): here they are only enabled,
 * granted permissions, and tested. From this panel the file can be opened and the bridge restarted.
 * Cards are reused between refreshes (never recreated), so transitions animate instead of jumping.
 *
 * Fork addition: per-host toggles in Settings. Each supported AI site can be enabled or
 * disabled independently, so a user can keep DeepSeek on while Claude stays off.
 */
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER, SUPPORTED_HOSTS, HOST_LABELS } from '../shared/constants.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS_TEXT = {
  connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected (reconnecting)', error: 'Connection error',
};
const DEMO_TOOL = 'system_info';

const ICONS = {
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};
for (const el of document.querySelectorAll('.ico[data-ico]')) el.innerHTML = ICONS[el.dataset.ico] ?? '';

async function api(type, payload = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ type, ...payload }); } catch (err) { throw new Error(err.message); }
  if (!res?.ok) throw new Error(res?.error ?? 'Unknown error.');
  return res;
}

function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
  await refresh(true);
};

const openLink = (url) => {
  try { if (new URL(url).protocol === 'https:') chrome.tabs.create({ url }); } catch { /* invalid link */ }
};

const setLabel = (btn, text) => { btn.querySelector('span:not(.ico)').textContent = text; };
const setBusy = (btn, busy) => { btn.disabled = busy; btn.classList.toggle('busy', busy); };

const isDemo = (server) => {
  if (String(server.name).toLowerCase() === 'demo') return true;
  try { return new URL(server.url).port === new URL(DEMO_SERVER.url).port; } catch { return false; }
};

let latest = null;

// ───────────────────────── Bridge ─────────────────────────

let restarting = false;
let opening = false;
let togglingBridge = false;

function renderBridge(state) {
  const b = state.bridge ?? {};
  const dot = $('#bridge-dot');
  const title = $('#bridge-title');
  const sub = $('#bridge-sub');
  const hint = $('#offline-hint');
  const cfgErr = $('#config-error');

  if (!b.checked) {
    dot.className = 'dot connecting';
    title.textContent = 'Checking bridge…';
    sub.textContent = '';
  } else if (b.online) {
    dot.className = 'dot online';
    title.textContent = 'Bridge connected';
    const listening = state.servers.filter((s) => s.bridgeStatus === 'listening').length;
    sub.textContent = `v${b.version ?? '?'} · ${listening} server${listening === 1 ? '' : 's'} published`;
  } else {
    dot.className = 'dot offline';
    title.textContent = 'Bridge is off';
    sub.textContent = 'The extension cannot find it on this machine.';
  }

  cfgErr.hidden = !(b.online && b.configError);
  if (!cfgErr.hidden) cfgErr.textContent = `servers.json has an error: ${b.configError}. Fix it and save: the bridge reloads automatically (previous config stays active meanwhile).`;

  hint.hidden = !(b.checked && !b.online);
  if (!hint.hidden) {
    if (b.launcherOnline) {
      hint.textContent = b.paused
        ? 'The bridge is off on purpose. Click "Start bridge" to turn it on.'
        : 'The bridge crashed; the launcher is restarting it. If it does not come back, click "Start bridge".';
    } else {
      hint.replaceChildren('To start it from here, install the launcher once: double-click ', Object.assign(document.createElement('code'), { textContent: 'server/install.cmd' }),
        '. Meanwhile you can start it manually with ', Object.assign(document.createElement('code'), { textContent: 'server/start_bridge_loop.pyw' }), '.');
    }
  }

  const toggle = $('#toggle-bridge');
  if (!togglingBridge) {
    setLabel(toggle, b.online ? 'Stop bridge' : 'Start bridge');
    toggle.disabled = !b.checked || !b.launcherOnline;
    toggle.title = b.launcherOnline
      ? (b.online ? 'Stops the bridge (it stays off until you start it again)' : 'Starts the bridge')
      : 'Requires the launcher: install once with server/install.cmd';
  }

  const restart = $('#restart-bridge');
  if (!restarting) {
    restart.disabled = !b.checked || (!b.online && !b.launcherOnline);
    setLabel(restart, b.online ? 'Restart bridge' : 'Start (restart)');
    restart.title = (!b.online && !b.launcherOnline) ? 'Requires the launcher: install once with server/install.cmd' : 'Closes ALL bridges (from any folder) and opens a fresh one; starts it if it was off';
  }
  $('#open-config').title = b.config ? `Open ${b.config}` : 'Open servers.json in your editor';
}

$('#open-config').addEventListener('click', async (event) => {
  if (opening) return;
  opening = true;
  setBusy(event.currentTarget, true);
  try {
    await api('OPEN_CONFIG');
    toast('Opening servers.json… save the file and the bridge reloads automatically.');
  } catch (err) {
    const path = latest?.bridge?.config;
    toast(path && !err.message.includes(path) ? `${err.message} File: ${path}` : err.message, 6500);
  } finally {
    opening = false;
    setBusy(event.currentTarget, false);
  }
});

$('#open-editor').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('editor/editor.html');
  try {
    const [existing] = await chrome.tabs.query({ url });
    if (existing) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); window.close(); return; }
  } catch { /* no tab permission: open a new one */ }
  chrome.tabs.create({ url });
  window.close();
});

$('#toggle-bridge').addEventListener('click', async (event) => {
  if (togglingBridge) return;
  const btn = event.currentTarget;
  const turnOff = Boolean(latest?.bridge?.online);
  togglingBridge = true;
  setBusy(btn, true);
  setLabel(btn, turnOff ? 'Stopping…' : 'Starting…');
  try {
    const res = await api(turnOff ? 'STOP_BRIDGE' : 'START_BRIDGE');
    toast(turnOff ? 'Bridge stopped.' : (res.configError ? 'Bridge started, but servers.json has an error.' : 'Bridge started ✓'), 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    togglingBridge = false;
    setBusy(btn, false);
    await refresh(true);
  }
});
$('#restart-bridge').addEventListener('click', async (event) => {
  if (restarting) return;
  const btn = event.currentTarget;
  restarting = true;
  setBusy(btn, true);
  setLabel(btn, 'Restarting…');
  try {
    const res = await api('BRIDGE_GLOBAL', { action: 'restart' });
    toast(res.configError ? 'Bridge restarted, but servers.json has an error.' : 'Bridge restarted ✓', 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    restarting = false;
    setBusy(btn, false);
    setLabel(btn, latest?.bridge?.online ? 'Restart bridge' : 'Start (restart)');
    await refresh(true);
  }
});

// ───────────────────────── Servers ─────────────────────────

const cards = new Map();
const demoOutputs = new Map();

function permSelect(onChange, label) {
  const select = document.createElement('select');
  select.className = 'perm';
  select.setAttribute('aria-label', label);
  for (const perm of PERMISSIONS) select.append(new Option(PERMISSION_LABELS[perm], perm));
  select.addEventListener('change', guard(() => onChange(select.value)));
  return select;
}

function buildCard(server) {
  const card = { server, els: {} };
  const li = document.createElement('li');
  li.className = 'server';

  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: card.server.id, enabled: checkbox.checked })));
  toggle.append(checkbox, document.createElement('span'));

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  const dot = document.createElement('i');
  const title = document.createElement('span');
  title.className = 'title';
  const manual = document.createElement('span');
  manual.className = 'badge';
  manual.textContent = 'manual';
  manual.title = 'Added by hand in older versions (not from servers.json)';
  const demo = document.createElement('span');
  demo.className = 'badge demo';
  demo.textContent = 'demo';
  demo.title = 'Test server shipped with the extension';
  name.append(dot, title, manual, demo);
  const meta = document.createElement('div');
  meta.className = 'meta';

  const tools = document.createElement('div');
  tools.className = 'tools';
  const select = permSelect((value) => api('SET_PERMISSION', { id: card.server.id, permission: value }), `Permission for ${server.name}`);
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'test-btn';
  test.innerHTML = `${ICONS.play}<span>Test</span>`;
  test.title = `Runs ${DEMO_TOOL}: shows real machine data (enables the demo if needed)`;
  test.addEventListener('click', () => runDemo(card));
  tools.append(select, test);
  info.append(name, meta, tools);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn danger';
  remove.innerHTML = ICONS.trash;
  remove.title = 'Remove from the extension';
  remove.setAttribute('aria-label', 'Remove from the extension');
  remove.dataset.armed = 'Sure?';
  remove.addEventListener('click', () => {
    if (!remove.classList.contains('armed')) {
      remove.classList.add('armed');
      clearTimeout(remove.timer);
      remove.timer = setTimeout(() => remove.classList.remove('armed'), 2600);
      return;
    }
    clearTimeout(remove.timer);
    guard(() => api('REMOVE_SERVER', { id: card.server.id }))();
  });
  actions.append(remove);

  li.append(toggle, info, actions);
  Object.assign(card, { li, els: { toggle, checkbox, dot, title, manual, demo, meta, select, test, remove, out: null } });
  return card;
}

function updateCard(card, server, activeCount) {
  card.server = server;
  const { li, els } = card;
  li.classList.toggle('on', server.enabled);

  els.toggle.title = server.enabled ? 'Disable' : 'Enable';
  els.checkbox.checked = server.enabled;
  els.checkbox.disabled = !server.enabled && activeCount >= MAX_ACTIVE_SERVERS;
  els.checkbox.setAttribute('aria-label', `Enable ${server.name}`);

  const bridgeBroken = server.bridgeStatus === 'error';
  els.dot.className = `dot ${bridgeBroken ? 'error' : (server.enabled ? server.status : '')}`;
  els.title.textContent = server.name;
  els.title.title = server.name;
  els.manual.hidden = Boolean(server.auto);
  els.demo.hidden = !isDemo(server);
  els.remove.parentElement.hidden = Boolean(server.auto);

  let meta;
  if (bridgeBroken) meta = `${server.url} · The bridge could not open it: ${server.bridgeError ?? 'error'}`;
  else if (server.permission === 'deny') meta = `${server.url} · Blocked (not described to the AI)`;
  else if (server.enabled) {
    meta = `${server.url} · ${STATUS_TEXT[server.status] ?? server.status}${server.status === 'connected' ? ` · ${server.toolCount} tools` : ''}`;
  } else meta = server.url;
  els.meta.textContent = meta;
  els.meta.classList.toggle('err', bridgeBroken);
  els.meta.title = server.enabled && server.error && server.status !== 'connected' ? server.error : '';

  if (document.activeElement !== els.select) els.select.value = server.permission;
  els.select.dataset.perm = server.permission;
  els.test.hidden = !isDemo(server);

  const out = demoOutputs.get(server.id);
  if (out) {
    if (!els.out) {
      els.out = document.createElement('div');
      els.out.className = 'demo-out';
      els.out.title = 'Click to hide';
      els.out.append(document.createElement('pre'));
      els.out.addEventListener('click', () => { demoOutputs.delete(card.server.id); updateCard(card, card.server, activeCount); });
      li.append(els.out);
    }
    els.out.classList.toggle('bad', !out.ok);
    els.out.firstChild.textContent = out.text;
  } else if (els.out) {
    els.out.remove();
    els.out = null;
  }
}

async function runDemo(card) {
  const btn = card.els.test;
  btn.disabled = true;
  try {
    if (!card.server.enabled) await api('TOGGLE_SERVER', { id: card.server.id, enabled: true });
    const res = await api('CALL_TOOL', { server: card.server.slug ?? card.server.name, name: DEMO_TOOL, arguments: {} });
    const text = (res.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    demoOutputs.set(card.server.id, { ok: !res.result?.isError, text: text || 'The server replied without text.' });
  } catch (err) {
    const hint = /does not exist|not active|not connected|no existe/.test(err.message) ? '\nRestart the bridge to load the updated demo.' : '';
    demoOutputs.set(card.server.id, { ok: false, text: err.message + hint });
  } finally {
    btn.disabled = false;
    await refresh(true);
  }
}

function renderServers(state) {
  const list = $('#server-list');
  const active = state.servers.filter((s) => s.enabled);

  $('#counter').textContent = `${active.length}/${MAX_ACTIVE_SERVERS} active`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `≈ ${tokens.toLocaleString('en')} tool tokens` : '';

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `You have ${active.length} MCPs active. Every tool takes context and may saturate the AI. Recommended: 1 at a time.`;
  $('#empty').hidden = state.servers.length > 0;

  const seen = new Set();
  state.servers.forEach((server, index) => {
    seen.add(server.id);
    let card = cards.get(server.id);
    if (!card) {
      card = buildCard(server);
      cards.set(server.id, card);
      card.li.classList.add('enter');
      card.li.style.setProperty('--i', index);
      card.li.addEventListener('animationend', (e) => { if (e.target === card.li) card.li.classList.remove('enter'); });
    }
    updateCard(card, server, active.length);
    if (list.children[index] !== card.li) list.insertBefore(card.li, list.children[index] ?? null);
  });
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    cards.delete(id);
    card.li.classList.add('leaving');
    setTimeout(() => card.li.remove(), 260);
  }
}

function renderGlobalPermission(servers) {
  const select = $('#perm-all');
  const perms = new Set(servers.map((s) => s.permission));
  const value = perms.size === 1 ? [...perms][0] : (perms.size === 0 ? 'ask' : 'mixed');
  select.value = value;
  select.dataset.perm = value;
  $('#perm-all').closest('.perm-all').hidden = servers.length === 0;
  $('#perm-hint').textContent = {
    allow: 'All allowed: nothing is asked.',
    ask: 'Asked on every AI call.',
    deny: 'All blocked: the AI receives no tools.',
    mixed: 'Each MCP has a different permission.',
  }[value];
}
$('#perm-all').addEventListener('change', guard((e) => api('SET_ALL_PERMISSIONS', { permission: e.target.value })));

// ───────────────────────── Per-host toggles ─────────────────────────

const hostRows = new Map();

function buildHostRow(host) {
  const row = document.createElement('label');
  row.className = 'setting host-row';
  const sw = document.createElement('span');
  sw.className = 'switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', guard(() => api('UPDATE_HOST_ENABLED', { host, enabled: checkbox.checked })));
  sw.append(checkbox, document.createElement('span'));

  const txt = document.createElement('span');
  txt.className = 'txt';
  const strong = document.createElement('strong');
  strong.textContent = `${HOST_LABELS[host] ?? host} (${host})`;
  const small = document.createElement('small');
  small.textContent = '';
  txt.append(strong, small);

  row.append(sw, txt);
  return { row, checkbox, small };
}

function renderHosts(state) {
  const list = $('#host-list');
  if (!list) return;
  const hostEnabled = state.settings?.hostEnabled ?? {};
  for (const host of SUPPORTED_HOSTS) {
    let entry = hostRows.get(host);
    if (!entry) {
      entry = buildHostRow(host);
      hostRows.set(host, entry);
      list.append(entry.row);
    }
    const on = hostEnabled[host] !== false;
    if (document.activeElement !== entry.checkbox) entry.checkbox.checked = on;
    entry.checkbox.setAttribute('aria-label', `Enable bridge on ${host}`);
    entry.checkbox.disabled = state.settings?.bridgeEnabled === false;
    entry.small.textContent = on
      ? 'Injection and tools are active on this site.'
      : 'Injection and tools are OFF only on this site. Other sites are not affected.';
  }
}

// ───────────────────────── Notices ─────────────────────────

const LEVEL_TEXT = { info: 'News', update: 'New version', warning: 'Important' };
let noticesSig = '';

function renderNotices(state) {
  const data = state.notices ?? { items: [], unread: 0 };
  const badge = $('#notices-badge');
  badge.hidden = !data.unread;
  badge.textContent = data.unread > 9 ? '9+' : String(data.unread);

  const sig = JSON.stringify([data.items, data.checkedAt, data.error]);
  if (sig === noticesSig) return;
  noticesSig = sig;

  const list = $('#notice-list');
  list.replaceChildren();
  $('#notices-empty').hidden = data.items.length > 0;
  $('#read-all').hidden = !data.unread;

  for (const n of data.items) {
    const li = document.createElement('li');
    li.className = `notice ${n.level}${n.unread ? ' unread' : ''}`;
    const title = document.createElement('div');
    title.className = 'n-title';
    title.textContent = n.title;
    const date = document.createElement('div');
    date.className = 'n-date';
    date.textContent = [LEVEL_TEXT[n.level], n.date ? new Date(n.date).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : null].filter(Boolean).join(' · ');
    li.append(title, date);
    if (n.message) {
      const msg = document.createElement('div');
      msg.className = 'n-msg';
      msg.textContent = n.message;
      li.append(msg);
    }
    const actions = document.createElement('div');
    actions.className = 'n-actions';
    if (n.url) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'primary small';
      open.textContent = 'View on GitHub';
      open.addEventListener('click', guard(async () => { openLink(n.url); await api('READ_NOTICES', { ids: [n.id] }); }));
      actions.append(open);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'soft small';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', guard(() => api('DISMISS_NOTICE', { id: n.id })));
    actions.append(dismiss);
    li.append(actions);
    list.append(li);
  }

  const when = data.checkedAt ? `Checked ${new Date(data.checkedAt).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' })}` : 'Not checked yet';
  $('#notices-line').textContent = data.error ? `${data.error}` : when;
}
$('#read-all').addEventListener('click', guard(() => api('READ_NOTICES', { ids: 'all' })));
$('#check-notices').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  setBusy(btn, true);
  try {
    const res = await api('CHECK_NOTICES');
    toast(res.count ? `There ${res.count === 1 ? 'is' : 'are'} ${res.count} current notice${res.count === 1 ? '' : 's'}.` : 'No new notices.');
  } catch (err) { toast(err.message, 5000); }
  setBusy(btn, false);
  noticesSig = '';
  await refresh(true);
});

// ───────────────────────── History ─────────────────────────

let historySig = '';
async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  const sig = JSON.stringify(history);
  if (sig === historySig) return;
  historySig = sig;
  const list = $('#history-list');
  list.replaceChildren();
  $('#history-empty').hidden = history.length > 0;
  history.forEach((h, index) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', Math.min(index, 10));
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('span');
    title.textContent = `${h.server} · ${h.tool}`;
    const status = document.createElement('span');
    status.className = h.status;
    status.textContent = h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : 'Error';
    row.append(title, status);
    const detail = document.createElement('small');
    detail.textContent = `${new Date(h.ts).toLocaleTimeString('en')} · ${h.error ?? h.args}`;
    li.append(row, detail);
    list.append(li);
  });
}
$('#clear-history').addEventListener('click', guard(async () => { await api('CLEAR_HISTORY'); historySig = ''; }));

// ───────────────────────── Settings ─────────────────────────

function renderSettings(state) {
  const { settings } = state;
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = settings.bridgeEnabled ? 'Enabled' : 'Disabled';
  $('#main').classList.toggle('off', !settings.bridgeEnabled);
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = settings.maxResultChars;
  $('#set-autoInject').checked = settings.autoInject;
  $('#set-autoSend').checked = settings.autoSend;
  $('#set-reminder').checked = settings.reminder;
  $('#set-autoDiscover').checked = settings.autoDiscover !== false;
  $('#set-autoEnableDiscovered').checked = Boolean(settings.autoEnableDiscovered);
  $('#set-focusFallback').checked = settings.focusFallback;
  $('#set-showNotices').checked = settings.showNotices !== false;
  if (document.activeElement?.id !== 'set-reinjectEvery') $('#set-reinjectEvery').value = settings.reinjectEvery;
  if (document.activeElement?.id !== 'set-responseDelaySec') $('#set-responseDelaySec').value = (settings.responseDelayMs ?? 1500) / 1000;

  renderHosts(state);

  $('#version').textContent = state.version ? `v${state.version}` : '';
  $('#version-line').textContent = state.version ? `Web MCP Bridge (Fork) v${state.version}` : '';
}

$('#gh-link').addEventListener('click', (e) => { e.preventDefault(); openLink('https://github.com/ranggaas6/web-mcp-bridge'); });

$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));

for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'autoDiscover', 'autoEnableDiscovered', 'showNotices']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#set-reinjectEvery').addEventListener('change', guard((e) => {
  const value = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { reinjectEvery: value } });
}));
$('#set-responseDelaySec').addEventListener('change', guard((e) => {
  const seconds = Math.min(60, Math.max(0, Number(e.target.value) || 0));
  return api('UPDATE_SETTINGS', { settings: { responseDelayMs: Math.round(seconds * 1000) } });
}));
$('#discover-now').addEventListener('click', guard(async () => {
  const res = await api('DISCOVER', { reset: true });
  toast(res.added ? `Detected ${res.added} new server(s).` : 'Servers up to date.');
}));
$('#set-maxResultChars').addEventListener('change', guard((e) => {
  const value = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
  return api('UPDATE_SETTINGS', { settings: { maxResultChars: value } });
}));

// ───────────────────────── Tabs and refresh ─────────────────────────

let selectFocusedAt = 0;
document.addEventListener('focusin', (e) => { if (e.target.matches?.('select')) selectFocusedAt = Date.now(); });

const tabsBar = $('.tabs');
const ink = $('.tab-ink');
function moveInk() {
  const selected = tabsBar.querySelector('[aria-selected="true"]');
  if (!selected) return;
  ink.style.width = `${selected.offsetWidth}px`;
  ink.style.transform = `translateX(${selected.offsetLeft}px)`;
}
moveInk();
requestAnimationFrame(() => requestAnimationFrame(() => tabsBar.classList.add('ready')));

let currentTab = 'servers';
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === btn));
    for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `tab-${currentTab}`;
    moveInk();
    historySig = '';
    refresh(true);
  });
}

let lastSig = '';
async function refresh(force = false) {
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return;
  if (!force && document.activeElement?.matches('select') && Date.now() - selectFocusedAt < 6000) return;
  try {
    const state = await api('GET_STATE');
    latest = state;
    const sig = JSON.stringify([state.version, state.notices, state.settings, state.bridge,
      state.servers.map((s) => [s.id, s.name, s.url, s.enabled, s.permission, s.status, s.toolCount, s.auto, s.error, s.bridgeStatus, s.bridgeError])]);
    if (force || sig !== lastSig) {
      lastSig = sig;
      renderBridge(state);
      renderServers(state);
      renderGlobalPermission(state.servers);
      renderSettings(state);
      renderNotices(state);
    }
    if (currentTab === 'history') await renderHistory();
  } catch (err) { toast(err.message); }
}

refresh(true);
setInterval(refresh, 1500);
