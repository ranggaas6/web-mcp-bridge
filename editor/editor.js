/**
 * editor.js - servers.json editor inside the extension (v1.7.0).
 *
 * Reads and saves the file through the bridge (GET_CONFIG / SAVE_CONFIG in the service worker). The bridge validates,
 * leaves a servers.json.bak copy, writes atomically, and reloads MCPs instantly.
 * With the bridge off you can still edit and download; saving requires the bridge on.
 */
const $ = (selector, root = document) => root.querySelector(selector);

/** Sends a message to the service worker. Always returns a response (ok or not) so offline / oldBridge can be handled. */
async function send(type, payload = {}) {
  try { return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { ok: false, error: 'No response from the extension.' }; } catch (err) { return { ok: false, error: err.message }; }
}

function toast(message, ms = 3600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

const DEFAULT_TEXT = '{\n  "control_port": 8199,\n  "launcher_port": 8198,\n  "servers": []\n}\n';
const RESERVED_PORTS = new Set([8198, 8199]);
const TEMPLATES = [
  { label: 'Windows Administrator', name: 'windows-administrator', command: "cmd.exe /d /c 'python -m pip show -q windows-server-mcp >nul 2>&1 || python -m pip install -q windows-server-mcp >nul 2>&1 & python -m windows_server_mcp.server'", hint: 'Installs itself from PyPI on first run (pip install windows-server-mcp)' },
  { label: 'Memory', name: 'memory', command: 'npx -y @modelcontextprotocol/server-memory' },
  { label: 'Fetch (web)', name: 'fetch', command: 'uvx mcp-server-fetch' },
  { label: 'Demo', name: 'demo', command: 'python server/examples/demo_mcp_server.py' },
];

const editor = $('#editor');
const gutter = $('#gutter');
const saveBtn = $('#b-save');
const view = { saved: '', path: '', online: false, bridgeChecked: false, canSave: false, last: null };

// ───────────────────────── JSON helpers ─────────────────────────

/** Readable JSON: short arrays of simple values (like "command") stay on one line. */
function pretty(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((x) => x === null || typeof x !== 'object')) {
      const one = `[${value.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (one.length + indent * 2 <= 90) return one;
    }
    return `[\n${value.map((x) => `${pad}  ${pretty(x, indent + 1)}`).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}  ${JSON.stringify(k)}: ${pretty(value[k], indent + 1)}`).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** Line (1-based) of a JSON.parse error, based on what the browser reports. */
function errorLine(text, err) {
  const m = /line (\d+) column (\d+)/.exec(err.message);
  if (m) return Number(m[1]);
  const p = /position (\d+)/.exec(err.message);
  if (p) return text.slice(0, Number(p[1])).split('\n').length;
  return null;
}

/** Same logic the bridge uses at startup, to warn before saving. */
function validate(text) {
  const errors = [];
  const warnings = [];
  if (!text.trim()) return { errors: [{ msg: 'The file is empty.' }], warnings, count: 0, data: null };
  let data;
  try { data = JSON.parse(text); } catch (err) {
    return { errors: [{ msg: `Malformed JSON: ${err.message.replace(/ in JSON at position \d+.*/, '')}`, line: errorLine(text, err) }], warnings, count: 0, data: null };
  }
  const entries = Array.isArray(data) ? data : (data && typeof data === 'object' ? data.servers : null);
  if (!Array.isArray(entries)) return { errors: [{ msg: 'Missing the "servers": [ ... ] list' }], warnings, count: 0, data };
  const names = new Set();
  const ports = new Map();
  let count = 0;
  entries.forEach((entry, i) => {
    const n = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push({ msg: `Server #${n} must be an object { ... }` }); return; }
    if (entry.disabled || entry.enabled === false) return;
    if (typeof entry.name !== 'string' || !entry.name.trim()) { errors.push({ msg: `Server #${n} has no "name"` }); return; }
    const label = `"${entry.name}"`;
    if (names.has(entry.name)) errors.push({ msg: `Name ${label} is duplicated`, name: entry.name });
    names.add(entry.name);
    const cmd = entry.command;
    const okCmd = (typeof cmd === 'string' && cmd.trim()) || (Array.isArray(cmd) && cmd.length && cmd.every((c) => ['string', 'number'].includes(typeof c)));
    if (!okCmd) errors.push({ msg: `${label}: "command" must be a non-empty list, e.g. ["python", "my_mcp.py"]`, name: entry.name });
    const port = Number(entry.port);
    if (entry.port === undefined || entry.port === null || entry.port === '' || !Number.isInteger(port)) errors.push({ msg: `${label}: missing "port" (a number, e.g. 8080)`, name: entry.name });
    else if (port < 1 || port > 65535) errors.push({ msg: `${label}: "port" must be between 1 and 65535`, name: entry.name });
    else {
      if (ports.has(port)) warnings.push({ msg: `Port ${port} is used by ${label} and "${ports.get(port)}": only one will be able to open.`, name: entry.name });
      else ports.set(port, entry.name);
      if (RESERVED_PORTS.has(port)) warnings.push({ msg: `${label}: port ${port} is used by the bridge/launcher; pick another.`, name: entry.name });
    }
    if (entry.env && (typeof entry.env !== 'object' || Array.isArray(entry.env))) errors.push({ msg: `${label}: "env" must be an object { "VARIABLE": "value" }`, name: entry.name });
    count += 1;
  });
  if (!Array.isArray(data) && data.control_port !== undefined && !Number.isInteger(Number(data.control_port))) errors.push({ msg: '"control_port" must be a number' });
  return { errors, warnings, count, data };
}

/** Line where "name": "xxx" appears (to jump from the issues list). */
function lineOfName(text, name) {
  const idx = text.indexOf(`"${name}"`);
  return idx < 0 ? null : text.slice(0, idx).split('\n').length;
}

/** Splits a command typed as in a terminal: respects quotes and leaves Windows backslashes untouched. */
function splitCommand(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of input.trim()) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; } else if (ch === '"' || ch === "'") { quote = ch; started = true; } else if (/\s/.test(ch)) {
      if (cur || started) { out.push(cur); cur = ''; started = false; }
    } else cur += ch;
  }
  if (quote) throw new Error('There are unclosed quotes in the command.');
  if (cur || started) out.push(cur);
  return out;
}

function parseEnv(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`Malformed variable: "${line}". Use KEY=value.`);
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

// ───────────────────────── Editor state ─────────────────────────

function updateGutter() {
  const lines = editor.value.split('\n').length;
  if (gutter.dataset.lines !== String(lines)) {
    gutter.dataset.lines = String(lines);
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  }
  gutter.scrollTop = editor.scrollTop;
}

function jumpToLine(line) {
  if (!line) return;
  const lines = editor.value.split('\n');
  const offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
  editor.scrollTop = Math.max(0, (line - 4) * 20);
}

function renderStatus() {
  const text = editor.value;
  const result = validate(text);
  view.last = result;
  const status = $('#status');
  const issues = $('#issues');
  issues.replaceChildren();
  const all = [...result.errors.map((e) => ({ ...e, kind: 'bad' })), ...result.warnings.map((w) => ({ ...w, kind: 'warn' }))];
  for (const item of all) {
    const li = document.createElement('li');
    li.className = item.kind;
    const line = item.line ?? (item.name ? lineOfName(text, item.name) : null);
    li.textContent = line ? `Line ${line} · ${item.msg}` : item.msg;
    li.addEventListener('click', () => jumpToLine(line));
    issues.append(li);
  }
  issues.hidden = all.length === 0;

  if (result.errors.length) { status.className = 'status bad'; status.textContent = `✕ ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`; } else if (result.warnings.length) {
    status.className = 'status warn';
    status.textContent = `⚠ Valid JSON · ${result.count} server${result.count === 1 ? '' : 's'} · ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`;
  } else { status.className = 'status ok'; status.textContent = `✓ Valid JSON · ${result.count} server${result.count === 1 ? '' : 's'}`; }

  const dirty = text !== view.saved;
  $('#dirty').textContent = dirty ? '● Unsaved' : 'Saved';
  $('#dirty').classList.toggle('on', dirty);
  saveBtn.disabled = !(dirty && !result.errors.length && view.canSave);
  saveBtn.title = !view.canSave ? 'Turn on the bridge to save' : (result.errors.length ? 'Fix the errors to save' : '');
}

function setText(text, { markSaved = false } = {}) {
  editor.value = text;
  if (markSaved) view.saved = text;
  updateGutter();
  renderStatus();
}

const isDirty = () => editor.value !== view.saved;

// ───────────────────────── Load and save ─────────────────────────

function banner(message, kind = 'warn') {
  const el = $('#banner');
  el.hidden = !message;
  el.className = `callout ${kind}`;
  el.textContent = message ?? '';
}

async function load({ keepDraft = false } = {}) {
  const res = await send('GET_CONFIG');
  if (res.ok) {
    view.path = res.path ?? '';
    view.canSave = true;
    $('#path').textContent = view.path;
    banner(null);
    const text = res.text && res.text.trim() ? res.text : DEFAULT_TEXT;
    if (keepDraft && isDirty()) { view.saved = res.text ?? ''; renderStatus(); } else setText(text, { markSaved: true });
    if (!res.text || !res.text.trim()) view.saved = '';
    renderStatus();
    return;
  }
  view.canSave = false;
  if (res.offline) banner('Bridge is off: you can edit and download. To save, turn it on.');
  else if (res.oldBridge) banner(res.error, 'bad');
  else banner(res.error ?? 'Could not read servers.json.', 'bad');
  if (!editor.value) setText(DEFAULT_TEXT, { markSaved: true });
  renderStatus();
}

async function save(label = '') {
  const result = validate(editor.value);
  if (result.errors.length) { toast('Fix the errors before saving.'); return; }
  saveBtn.classList.add('busy');
  saveBtn.disabled = true;
  const res = await send('SAVE_CONFIG', { text: editor.value });
  saveBtn.classList.remove('busy');
  if (res.ok) {
    view.saved = editor.value;
    const parts = [];
    for (const [key, word] of [['started', 'started'], ['stopped', 'stopped'], ['restarted', 'restarted']]) if (Array.isArray(res[key]) && res[key].length) parts.push(`${res[key].length} ${word}`);
    toast(`${label ? `${label} added and saved` : 'Saved'} ✓ ${parts.length ? `(${parts.join(', ')})` : ''}`, 4000);
    if (res.restart_needed) banner('You changed "control_port": restart the bridge so it uses the new port.', 'warn');
  } else {
    toast(res.error ?? 'Could not save.', 7000);
    if (res.offline || res.oldBridge) { view.canSave = false; await refreshBridge(); }
  }
  renderStatus();
}

function download() {
  const blob = new Blob([editor.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'servers.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ───────────────────────── Add / import MCP ─────────────────────────

/** Current document as an object { servers: [...] }; throws if the JSON is invalid. */
function currentDoc() {
  const text = editor.value.trim();
  if (!text) return { servers: [] };
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new Error(`The editor JSON has an error (${err.message.replace(/ in JSON at position \d+.*/, '')}). Fix it before adding.`); }
  if (Array.isArray(data)) return { servers: data };
  if (!data || typeof data !== 'object') throw new Error('The editor JSON must be an object { "servers": [...] }.');
  if (data.servers === undefined) data.servers = [];
  if (!Array.isArray(data.servers)) throw new Error('"servers" must be a list.');
  return data;
}

function nextFreePort(doc, extra = []) {
  const used = new Set([...RESERVED_PORTS, Number(doc.control_port) || 0, ...extra]);
  for (const s of doc.servers) if (s && Number.isInteger(Number(s.port))) used.add(Number(s.port));
  let port = 8080;
  while (used.has(port)) port += 1;
  return port;
}

function uniqueName(doc, wanted, taken) {
  const names = new Set([...doc.servers.map((s) => s?.name), ...taken]);
  if (!names.has(wanted)) return wanted;
  let n = 2;
  while (names.has(`${wanted}-${n}`)) n += 1;
  return `${wanted}-${n}`;
}

/** After add/import: saves immediately if possible (so the MCP shows up with no extra steps). */
async function afterAdd(label) {
  if (view.canSave && !validate(editor.value).errors.length) { await save(label); return; }
  toast(`${label} added. ${view.canSave ? 'Fix the errors and click Save.' : 'Turn on the bridge and click Save.'}`, 6000);
}
function addEntries(entries) {
  const doc = currentDoc();
  const addedNames = [];
  const addedPorts = [];
  for (const entry of entries) {
    const port = Number.isInteger(Number(entry.port)) && Number(entry.port) > 0 && !addedPorts.includes(Number(entry.port)) && !doc.servers.some((s) => Number(s?.port) === Number(entry.port))
      ? Number(entry.port) : nextFreePort(doc, addedPorts);
    const name = uniqueName(doc, entry.name, addedNames);
    const { name: _n, port: _p, ...rest } = entry;
    doc.servers.push({ name, port, ...rest });
    addedNames.push(name);
    addedPorts.push(port);
  }
  setText(`${pretty(doc)}\n`);
  editor.scrollTop = editor.scrollHeight;
  return addedNames;
}

/** Turns whatever the user pastes (Claude Desktop, Cursor, list, single object...) into servers.json entries. */
function toEntries(data) {
  let pairs = [];
  if (Array.isArray(data)) pairs = data.map((e) => [e?.name, e]);
  else if (data && typeof data === 'object') {
    if (data.mcpServers && typeof data.mcpServers === 'object') pairs = Object.entries(data.mcpServers);
    else if (data.mcp && data.mcp.servers && typeof data.mcp.servers === 'object') pairs = Object.entries(data.mcp.servers);
    else if (Array.isArray(data.servers)) pairs = data.servers.map((e) => [e?.name, e]);
    else if (data.command !== undefined || data.url !== undefined) pairs = [[data.name, data]];
    else pairs = Object.entries(data).filter(([, v]) => v && typeof v === 'object' && v.command !== undefined);
  }
  if (!pairs.length) throw new Error('No MCP found in that JSON. It must contain "mcpServers" or an object with "command".');
  return pairs.map(([key, raw], i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`MCP #${i + 1} is not an object.`);
    const name = String(raw.name ?? key ?? `mcp-${i + 1}`).trim() || `mcp-${i + 1}`;
    if (raw.command === undefined) throw new Error(`"${name}": only local MCPs started with a command are supported (no remote URLs).`);
    let command = typeof raw.command === 'string' ? (Array.isArray(raw.args) ? [raw.command] : splitCommand(raw.command)) : raw.command;
    if (!Array.isArray(command) || !command.length) throw new Error(`"${name}": "command" is not valid.`);
    if (Array.isArray(raw.args)) command = [...command, ...raw.args.map(String)];
    const entry = { name, command };
    if (raw.port !== undefined) entry.port = Number(raw.port);
    if (raw.cwd) entry.cwd = String(raw.cwd);
    if (raw.env && typeof raw.env === 'object') entry.env = raw.env;
    if (raw.disabled) entry.disabled = true;
    return entry;
  });
}

function fail(selector, message) {
  const el = $(selector);
  el.hidden = !message;
  el.textContent = message ?? '';
}

$('#f-add').addEventListener('click', async () => {
  fail('#form-error', null);
  try {
    const name = $('#f-name').value.trim();
    const cmdText = $('#f-cmd').value.trim();
    if (!name) throw new Error('Missing name.');
    if (!cmdText) throw new Error('Missing command.');
    const entry = { name, command: splitCommand(cmdText) };
    const port = $('#f-port').value.trim();
    if (port) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port must be between 1 and 65535.');
      entry.port = p;
    }
    const cwd = $('#f-cwd').value.trim();
    if (cwd) entry.cwd = cwd.replace(/\\/g, '/');
    const env = parseEnv($('#f-env').value);
    if (Object.keys(env).length) entry.env = env;
    const [added] = addEntries([entry]);
    await afterAdd(`"${added}"`);
    clearForm();
  } catch (err) { fail('#form-error', err.message); }
});

function clearForm() {
  for (const id of ['f-name', 'f-cmd', 'f-cwd', 'f-env']) $(`#${id}`).value = '';
  $('#f-port').value = '';
  suggestPort();
  fail('#form-error', null);
}
$('#f-clear').addEventListener('click', clearForm);

function suggestPort() {
  try { $('#f-port').placeholder = String(nextFreePort(currentDoc())); } catch { $('#f-port').placeholder = '8080'; }
}

$('#import-btn').addEventListener('click', async () => {
  fail('#import-error', null);
  try {
    const raw = $('#import-text').value.trim();
    if (!raw) throw new Error('Paste the MCP JSON first.');
    let data;
    try { data = JSON.parse(raw); } catch (err) { throw new Error(`That JSON is invalid: ${err.message.replace(/ in JSON at position \d+.*/, '')}`); }
    const added = addEntries(toEntries(data));
    await afterAdd(added.join(', '));
    $('#import-text').value = '';
  } catch (err) { fail('#import-error', err.message); }
});

for (const tpl of TEMPLATES) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = tpl.label;
  if (tpl.hint) chip.title = tpl.hint;
  chip.addEventListener('click', () => {
    $('#f-name').value = tpl.name;
    $('#f-cmd').value = tpl.command;
    $('#f-cmd').focus();
    suggestPort();
  });
  $('#templates').append(chip);
}

// ───────────────────────── Bridge (state and global buttons) ─────────────────────────

async function refreshBridge() {
  const res = await send('GET_STATE');
  if (!res.ok) return;
  const b = res.bridge ?? {};
  view.online = Boolean(b.online);
  view.bridgeChecked = Boolean(b.checked);
  const dot = $('#bridge-dot');
  dot.className = `dot ${!b.checked ? 'connecting' : (b.online ? 'online' : 'offline')}`;
  $('#bridge-text').textContent = !b.checked ? 'Checking…' : (b.online ? `Bridge connected${b.version ? ` v${b.version}` : ''}` : (b.paused ? 'Bridge paused' : 'Bridge off'));
  const toggle = $('#bridge-toggle');
  if (!toggle.classList.contains('busy')) {
    toggle.querySelector('span').textContent = b.online ? 'Stop' : 'Start';
    toggle.disabled = !b.checked || (!b.online && !b.launcherOnline);
    toggle.title = (!b.online && !b.launcherOnline) ? 'Requires the launcher: install once with server/install.cmd' : '';
  }
  const restart = $('#bridge-restart');
  if (!restart.classList.contains('busy')) restart.disabled = !b.checked || (!b.online && !b.launcherOnline);
  $('#version').textContent = res.version ? `v${res.version}` : '';
  $('#version-line').textContent = res.version ? `Web MCP Bridge (Fork) v${res.version}` : '';

  const couldSave = view.canSave;
  if (b.online && !couldSave && !isDirty()) await load();
  else if (b.online && !couldSave) { view.canSave = true; banner(null); renderStatus(); } else if (!b.online && couldSave) { view.canSave = false; banner('The bridge went off. Turn it on to be able to save.'); renderStatus(); }
}

async function bridgeAction(btn, action, busyLabel) {
  const label = btn.querySelector('span');
  const old = label.textContent;
  btn.classList.add('busy');
  btn.disabled = true;
  label.textContent = busyLabel;
  const res = await send('BRIDGE_GLOBAL', { action });
  btn.classList.remove('busy');
  label.textContent = old;
  if (!res.ok) toast(res.error ?? 'Could not complete the action.', 7000);
  else toast(action === 'stop' ? 'Bridge stopped.' : (action === 'start' ? 'Bridge started ✓' : 'Bridge restarted ✓'));
  await refreshBridge();
  if (action !== 'stop' && res.ok) await load({ keepDraft: true });
}
$('#bridge-toggle').addEventListener('click', (e) => bridgeAction(e.currentTarget, view.online ? 'stop' : 'start', view.online ? 'Stopping…' : 'Starting…'));
$('#bridge-restart').addEventListener('click', (e) => bridgeAction(e.currentTarget, 'restart', 'Restarting…'));

// ───────────────────────── Editor events ─────────────────────────

editor.addEventListener('input', () => { updateGutter(); renderStatus(); suggestPort(); });
editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: end } = editor;
    editor.setRangeText('  ', s, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!saveBtn.disabled) save(); }
});
saveBtn.addEventListener('click', save);
$('#b-download').addEventListener('click', download);
$('#b-format').addEventListener('click', () => {
  try {
    const data = JSON.parse(editor.value);
    setText(`${pretty(data)}\n`);
  } catch (err) { toast(`Cannot format: ${err.message.replace(/ in JSON at position \d+.*/, '')}`); }
});
$('#b-reload').addEventListener('click', async () => {
  if (isDirty() && !confirm('You have unsaved changes. Reload from disk and lose them?')) return;
  await load();
  toast('Reloaded from disk.');
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  await refreshBridge();
  await load();
  suggestPort();
  setInterval(refreshBridge, 3000);
})();
