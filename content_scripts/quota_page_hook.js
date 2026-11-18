/**
 * quota_page_hook.js (MAIN world, claude.ai only).
 * Reads ONLY the usage-limit fields (5h / 7d windows) that claude.ai attaches to every reply
 * and forwards them to quota_guard.js via window.postMessage. Reply text is never parsed or stored.
 * Technique adapted from claude-monitor-browser-extension (MIT, Digital Advanced Solutions).
 */
(() => {
  'use strict';
  if (window.__wmbxQuotaHook) return;
  window.__wmbxQuotaHook = true;

  const MAX_BYTES = 8388608;
  const MAX_LINE = 65536;
  const MAX_FRAME = 4194304;
  const MAX_DEPTH = 8;
  const RESET_AHEAD_S = 691200;
  const Q = String.fromCharCode(34);
  const ascii = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0));
  const DATA_PREFIX = ascii('data:');
  const EVENT_MARK = ascii(Q + 'message_limit' + Q);
  const previousFetch = window.fetch;

  window.fetch = function (input) {
    const pending = previousFetch.apply(this, arguments);
    const kind = classify(input);
    if (!kind) return pending;
    return pending.then((response) => {
      try {
        const scan = scannerFor(kind, response.headers.get('content-type') || '');
        if (scan) scan(response.clone()).catch(() => {});
      } catch (e) { /* skip */ }
      return response;
    });
  };

  function classify(input) {
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return null;
      const p = url.pathname.split('/');
      if (p.length === 7 && p[1] === 'api' && p[2] === 'organizations' && p[4] === 'chat_conversations' && (p[6] === 'completion' || p[6] === 'retry_completion')) return { type: 'completion' };
      if (url.pathname.startsWith('/claudeai-rpc/') && url.pathname.endsWith('ConversationService/StreamTimeline')) return { type: 'timeline' };
    } catch (e) { /* not ours */ }
    return null;
  }

  function scannerFor(kind, type) {
    if (kind.type === 'timeline') return type.includes('application/connect+proto') ? (r) => scanTimeline(r.body) : null;
    if (type.includes('text/event-stream')) return (r) => scanEventStream(r.body);
    if (type.includes('application/json')) return async (r) => { const f = findLimit(await r.json(), 0); if (f) report(f); };
    return null;
  }

  function post(session, weekly) {
    if (!session && !weekly) return;
    window.postMessage({ source: 'wmbx-quota', session, weekly }, location.origin);
  }

  function toWindow(w) {
    if (!w || typeof w !== 'object') return null;
    const utilization = Number(w.utilization);
    const resetsAt = Number(w.resets_at);
    if (!Number.isFinite(utilization) || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
    return { utilization, resetTime: resetsAt * 1000, exceeded: w.status === 'exceeded_limit' || utilization >= 1 };
  }

  function report(limit) {
    const w = limit && limit.windows;
    if (w) post(toWindow(w['5h']), toWindow(w['7d']));
  }

  function findLimit(node, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (node.message_limit && typeof node.message_limit === 'object') return node.message_limit;
    if (node.windows && typeof node.windows === 'object') return node;
    for (const key of Object.keys(node)) {
      const found = findLimit(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  async function scanEventStream(body) {
    if (!body) return;
    const reader = body.getReader();
    let carry = null;
    let skipping = false;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      let start = 0;
      for (let nl = value.indexOf(10); nl !== -1; nl = value.indexOf(10, start)) {
        if (!skipping) checkLine(carry ? concat(carry, value.subarray(start, nl)) : value.subarray(start, nl));
        carry = null;
        skipping = false;
        start = nl + 1;
      }
      if (!skipping && start < value.length) {
        carry = carry ? concat(carry, value.subarray(start)) : value.slice(start);
        if (carry.length > MAX_LINE) { carry = null; skipping = true; }
      }
      if (bytes > MAX_BYTES) { reader.cancel().catch(() => {}); return; }
    }
  }

  function checkLine(line) {
    if (!startsWith(line, DATA_PREFIX) || indexOfBytes(line, EVENT_MARK) === -1) return;
    try {
      const ev = JSON.parse(new TextDecoder().decode(line.subarray(DATA_PREFIX.length)));
      if (ev && ev.type === 'message_limit') report(ev.message_limit);
    } catch (e) { /* ignore */ }
  }

  async function scanTimeline(body) {
    if (!body) return;
    const reader = body.getReader();
    const queue = byteQueue();
    let frame = null;
    let skip = 0;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { reader.cancel().catch(() => {}); return; }
      queue.push(value);
      for (;;) {
        if (skip) {
          skip -= queue.drop(skip);
          if (skip) break;
        }
        if (!frame) {
          if (queue.size < 5) break;
          const head = queue.take(5);
          const flags = head[0];
          const length = head[1] * 16777216 + (head[2] << 16) + (head[3] << 8) + head[4];
          if (length > MAX_FRAME) { reader.cancel().catch(() => {}); return; }
          if (flags !== 0) { skip = length; continue; }
          frame = { length };
        }
        if (queue.size < frame.length) break;
        const payload = queue.take(frame.length);
        frame = null;
        readFrame(payload);
      }
    }
  }

  function readFrame(payload) {
    if (!payload || !(hasLabel(payload, 0x35, 0x68) || hasLabel(payload, 0x37, 0x64))) return;
    const found = {};
    findWindows(payload, 0, payload.length, 0, found);
    const rated = (w) => Boolean(w && w.utilization !== null);
    if (!rated(found.session) && !rated(found.weekly)) return;
    post(toLimit(found.session), toLimit(found.weekly));
  }

  function toLimit(w) {
    if (!w) return null;
    const u = w.utilization === null ? 0 : w.utilization;
    return { utilization: u, resetTime: w.resetsAt * 1000, exceeded: u >= 1 };
  }

  function labelAt(bytes, i) {
    if (bytes[i] === 0x35 && bytes[i + 1] === 0x68) return 'session';
    if (bytes[i] === 0x37 && bytes[i + 1] === 0x64) return 'weekly';
    return null;
  }

  function findWindows(bytes, start, end, depth, found) {
    const list = fields(bytes, start, end);
    if (!list) return;
    const label = list.find((f) => f.wire === 2 && f.end - f.start === 2 && labelAt(bytes, f.start));
    if (label) {
      const key = labelAt(bytes, label.start);
      if (!found[key]) found[key] = windowFrom(bytes, list.filter((f) => f !== label), depth);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const f of list) {
      if (f.wire === 2 && f.end > f.start) findWindows(bytes, f.start, f.end, depth + 1, found);
    }
  }

  function windowFrom(bytes, list, depth) {
    const hit = { utilization: null, resetsAt: null };
    collect(bytes, list, depth, hit, Date.now() / 1000);
    return hit.resetsAt === null ? null : hit;
  }

  function collect(bytes, list, depth, hit, nowS) {
    for (const f of list) {
      if (hit.utilization !== null && hit.resetsAt !== null) return;
      if (f.wire === 1 && hit.utilization === null) {
        const value = new DataView(bytes.buffer, bytes.byteOffset + f.start, 8).getFloat64(0, true);
        if (Number.isFinite(value) && value >= 0 && value <= 1.5) hit.utilization = value;
      } else if (f.wire === 0 && hit.resetsAt === null) {
        if (f.value > nowS - 3600 && f.value < nowS + RESET_AHEAD_S) hit.resetsAt = f.value;
      } else if (f.wire === 2 && depth < MAX_DEPTH) {
        const sub = fields(bytes, f.start, f.end);
        if (sub) collect(bytes, sub, depth + 1, hit, nowS);
      }
    }
  }

  function fields(bytes, start, end) {
    const list = [];
    let pos = start;
    while (pos < end) {
      const tag = varint(bytes, pos, end);
      if (!tag || tag.value < 8) return null;
      pos = tag.next;
      const wire = tag.value % 8;
      if (wire === 0) {
        const v = varint(bytes, pos, end);
        if (!v) return null;
        list.push({ wire, value: v.value });
        pos = v.next;
      } else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (pos + size > end) return null;
        list.push({ wire, start: pos, end: pos + size });
        pos += size;
      } else if (wire === 2) {
        const len = varint(bytes, pos, end);
        if (!len || len.next + len.value > end) return null;
        list.push({ wire, start: len.next, end: len.next + len.value });
        pos = len.next + len.value;
      } else {
        return null;
      }
    }
    return list;
  }

  function varint(bytes, pos, end) {
    let value = 0;
    for (let i = 0, scale = 1; i < 10 && pos < end; i++, scale *= 128) {
      const b = bytes[pos++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return { value, next: pos };
    }
    return null;
  }

  function byteQueue() {
    const chunks = [];
    let size = 0;
    return {
      get size() { return size; },
      push(chunk) {
        if (!chunk.byteLength) return;
        chunks.push(chunk);
        size += chunk.byteLength;
      },
      drop(n) {
        const count = Math.min(n, size);
        let left = count;
        while (left) {
          const head = chunks[0];
          if (head.byteLength <= left) { chunks.shift(); left -= head.byteLength; } else { chunks[0] = head.subarray(left); left = 0; }
        }
        size -= count;
        return count;
      },
      take(n) {
        const out = new Uint8Array(n);
        let offset = 0;
        while (offset < n) {
          const head = chunks[0];
          const k = Math.min(head.byteLength, n - offset);
          out.set(head.subarray(0, k), offset);
          offset += k;
          if (k === head.byteLength) chunks.shift(); else chunks[0] = head.subarray(k);
        }
        size -= n;
        return out;
      },
    };
  }

  function concat(a, b) {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a);
    out.set(b, a.byteLength);
    return out;
  }

  function startsWith(bytes, prefix) {
    if (bytes.byteLength < prefix.byteLength) return false;
    for (let i = 0; i < prefix.byteLength; i++) if (bytes[i] !== prefix[i]) return false;
    return true;
  }

  function indexOfBytes(bytes, needle) {
    for (let i = bytes.indexOf(needle[0]); i !== -1 && i + needle.byteLength <= bytes.byteLength; i = bytes.indexOf(needle[0], i + 1)) {
      let j = 1;
      while (j < needle.byteLength && bytes[i + j] === needle[j]) j++;
      if (j === needle.byteLength) return i;
    }
    return -1;
  }

  function hasLabel(bytes, a, b) {
    for (let i = bytes.indexOf(2); i !== -1 && i + 2 < bytes.byteLength; i = bytes.indexOf(2, i + 1)) {
      if (bytes[i + 1] === a && bytes[i + 2] === b) return true;
    }
    return false;
  }
})();
