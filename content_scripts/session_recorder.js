/**
 * session_recorder.js - Merekam seluruh percakapan claude.ai ke ~/.easy-vibe/sessions/<chat>.md.
 * Sumber: API internal claude.ai (same-origin, cookie sesi), cara yang sama dengan claude-chat-exporter.
 * Jalur tulis: background/conv_relay.js -> control port bridge (/conv/*). Bukan native host,
 * jadi kegagalan perekaman tidak bisa menghentikan bridge.
 * Hanya mengirim selisih: bridge ditanya dulu uuid mana yang sudah tersimpan.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.recorderStarted || location.hostname !== 'claude.ai') return;
  WMB.recorderStarted = true;
  const adapter = WMB.findAdapter ? WMB.findAdapter(location.hostname) : null;
  const NL = String.fromCharCode(10);
  const POLL_MS = 4000;
  const BACKOFF_MAX_MS = 120000;
  const MAX_BATCH_BYTES = 200000;
  const MAX_OBJ_BYTES = 1500000;
  const LIM = 150000;
  const Q = ['?tree=True&rendering_mode=messages&render_all_tools=true', '?tree=True&rendering_mode=messages', ''];

  const pending = new Map();
  const enc = new TextEncoder();
  let orgCache = null;
  let port = null;
  let rid = 0;
  let busy = false;
  let prevKey = '';
  let doneKey = '';
  let fails = 0;
  let nextTry = 0;

  const bytes = (s) => enc.encode(s).length;
  const cap = (s) => (typeof s === 'string' && s.length > LIM ? s.slice(0, LIM) + '...[dipotong]' : (s || ''));
  const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(NL) : '');

  const getPort = () => {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'wmbx-conv' });
      port.onMessage.addListener((m) => {
        const p = pending.get(m && m.rid);
        if (p) { pending.delete(m.rid); p(m); }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        for (const p of pending.values()) p({ ok: false, error: 'disconnected' });
        pending.clear();
      });
    } catch (e) { port = null; }
    return port;
  };

  const call = (op, body) => new Promise((resolve) => {
    const p = getPort();
    if (!p) { resolve({ ok: false, error: 'no port' }); return; }
    const id = ++rid;
    const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'timeout' }); }, 25000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    try { p.postMessage({ rid: id, op, body }); } catch (e) { clearTimeout(t); pending.delete(id); resolve({ ok: false, error: String(e) }); }
  });

  const getJson = async (path) => {
    const r = await fetch(location.origin + path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };

  const convIdNow = () => {
    const parts = location.pathname.split('/');
    const i = parts.indexOf('chat');
    const v = i >= 0 ? parts[i + 1] : '';
    return v && v.length === 36 ? v : '';
  };

  const orgIds = async () => {
    if (orgCache) return orgCache;
    const raw = await getJson('/api/organizations');
    let ids = raw.map((o) => o.uuid || o.id).filter(Boolean);
    const k = document.cookie.split('; ').find((c) => c.startsWith('lastActiveOrg='));
    const last = k ? k.slice(14) : '';
    if (last) ids = [last].concat(ids.filter((x) => x !== last));
    return ids;
  };

  const fetchConv = async (conv) => {
    let err = null;
    for (const o of await orgIds()) {
      for (const q of Q) {
        try {
          const c = await getJson('/api/organizations/' + o + '/chat_conversations/' + conv + q);
          orgCache = [o];
          return c;
        } catch (e) { err = e; }
      }
    }
    throw err || new Error('conversation not found');
  };

  const toObj = (m, idx) => {
    const blocks = Array.isArray(m.content) && m.content.length ? m.content : null;
    let text = '';
    const extra = [];
    if (!blocks) text = m.text || '';
    else {
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text') text += (text ? NL : '') + (b.text || '');
        else if (b.type === 'tool_use') extra.push({ k: 'tool_use', name: b.name, input: b.input });
        else if (b.type === 'tool_result') extra.push({ k: 'tool_result', name: b.name, text: cap(flat(b.content)) });
        else if (b.type === 'thinking' && b.thinking) extra.push({ k: 'thinking', text: cap(b.thinking) });
      }
    }
    const o = { uuid: m.uuid, parent: m.parent_message_uuid, i: idx, role: m.sender === 'human' ? 'user' : 'assistant', ts: m.created_at, text: cap(text) };
    const att = (m.attachments || []).filter((a) => a && a.extracted_content != null).map((a) => ({ name: a.file_name, text: cap(a.extracted_content) }));
    if (att.length) o.att = att;
    if (extra.length) o.extra = extra;
    if (bytes(JSON.stringify(o)) > MAX_OBJ_BYTES) {
      o.text = (o.text || '').slice(0, 50000) + '...[dipotong]';
      delete o.att;
      delete o.extra;
    }
    return o;
  };

  const syncConv = async (conv) => {
    const c = await fetchConv(conv);
    let msgs = c.chat_messages || [];
    if (c.current_leaf_message_uuid) {
      const map = new Map(msgs.map((x) => [x.uuid, x]));
      const chain = [];
      const seen = new Set();
      let cur = map.get(c.current_leaf_message_uuid);
      while (cur && !seen.has(cur.uuid)) { seen.add(cur.uuid); chain.push(cur); cur = map.get(cur.parent_message_uuid); }
      if (chain.length) msgs = chain.reverse();
    }
    const st = await call('state', { chat: conv });
    if (!st || !st.ok) return false;
    const known = new Set(st.uuids || []);
    let batch = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return true;
      const r = await call('append', { chat: conv, messages: batch });
      if (!r || !r.ok) return false;
      batch = [];
      size = 0;
      return true;
    };
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      if (known.has(m.uuid)) continue;
      const o = toObj(m, i);
      const n = bytes(JSON.stringify(o));
      if (batch.length && size + n > MAX_BATCH_BYTES && !(await flush())) return false;
      batch.push(o);
      size += n;
    }
    return flush();
  };

  const keyNow = () => {
    const ms = adapter && typeof adapter.getAssistantMessages === 'function' ? adapter.getAssistantMessages() : [];
    const lastLen = ms.length ? (ms[ms.length - 1].textContent || '').length : 0;
    return convIdNow() + '|' + ms.length + '|' + lastLen;
  };

  const bump = () => {
    fails += 1;
    nextTry = Date.now() + Math.min(BACKOFF_MAX_MS, POLL_MS * 2 ** fails);
  };

  const timer = setInterval(async () => {
    if (!WMB.extensionAlive()) { clearInterval(timer); return; }
    const conv = convIdNow();
    if (!conv || busy || Date.now() < nextTry) return;
    if (adapter && typeof adapter.isStreaming === 'function' && adapter.isStreaming()) { prevKey = ''; return; }
    const k = keyNow();
    if (k !== prevKey) { prevKey = k; return; }
    if (k === doneKey) return;
    busy = true;
    try {
      if (await syncConv(conv)) { doneKey = k; fails = 0; } else bump();
    } catch (e) {
      bump();
    } finally {
      busy = false;
    }
  }, POLL_MS);
})();
