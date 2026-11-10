/**
 * chatgpt.js — Adapter for ChatGPT (chatgpt.com).
 *
 * This adapter uses its OWN observer (not the base adapter's): the ChatGPT UI swaps the message container
 * (code viewer) and the `mcp_call` call may live in a code block, outside the message, or in plain text.
 * So it is located by its TEXT, not by message selectors.
 *
 *  - When ChatGPT replies with plain text, its Markdown eats backslashes
 *    (`C:\\Users` → `C:\Users`) and the JSON becomes invalid: it is repaired before parsing.
 *  - Anti-repetition WITHOUT persistent memory: a call is executed only once while it stays visible on the
 *    page; when it disappears (another chat, regenerate…) it is forgotten. Nothing is stored across reloads,
 *    so a new task is never blocked by an "already executed".
 *  - History: if there has been no recent activity (your send or live generation), what is on the page is
 *    old and is never executed, no matter how long it takes to load.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const USER_SEL = '[data-message-author-role="user"], [data-turn="user"]';
  const CACHE_MS = 300;
  const STABLE_MS = 1200;
  const STUCK_MS = 2500;
  const POLL_MS = 700;
  const ACTIVE_MS = 180_000;
  const FORGET_MS = 8000;

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE']);
  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT']);

  function extractText(root) {
    let out = '';
    const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'BR') { out += '\n'; return; }
      const isBlock = BLOCK_TAGS.has(tag) || node.classList.contains('cm-line');
      if (isBlock) newline();
      for (const child of node.childNodes) walk(child);
      if (isBlock) newline();
    };
    walk(root);
    return out;
  }

  function findJsonObjects(text) {
    const found = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '{') continue;
      let depth = 0; let inString = false; let escaped = false;
      for (let j = i; j < text.length; j += 1) {
        const ch = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try { found.push(JSON.parse(text.slice(i, j + 1))); i = j; } catch { /* not valid JSON */ }
            break;
          }
        }
      }
    }
    return found;
  }

  function fixString(raw) {
    if (/^[A-Za-z]:\\/.test(raw)) return raw.replace(/\\+/g, '\\\\');
    return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, valid) => (valid ? m : '\\\\'));
  }

  function repairBackslashes(text) {
    let out = ''; let i = 0;
    while (i < text.length) {
      if (text[i] !== '"') { out += text[i]; i += 1; continue; }
      let j = i + 1; let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { raw += text[j] + text[j + 1]; j += 2; }
        else { raw += text[j]; j += 1; }
      }
      out += '"' + fixString(raw) + '"';
      i = j + 1;
    }
    return out;
  }

  function parseCalls(text) {
    try {
      const direct = WMB.extractMcpCalls(text);
      if (direct?.length) return direct;
    } catch { /* try variants */ }

    const clean = text.replace(/[“”]/g, '"').replace(/\u00a0/g, ' ');
    for (const variant of [text, repairBackslashes(clean)]) {
      for (const obj of findJsonObjects(variant)) {
        if (!obj || typeof obj !== 'object' || !('mcp_call' in obj)) continue;
        try {
          const normalized = WMB.extractMcpCalls('```json\n' + JSON.stringify(obj) + '\n```');
          if (normalized?.length) return normalized;
        } catch { /* next candidate */ }
      }
    }
    return [];
  }

  function messageText(element) {
    const text = extractText(element);
    if (!text.includes('mcp_call')) return text;
    try { if (WMB.extractMcpCalls(text).length) return text; } catch { /* try repair */ }
    const calls = parseCalls(text);
    if (!calls.length) return text;
    return `${text}\n${calls.map((call) => '```json\n' + JSON.stringify({ mcp_call: call }) + '\n```').join('\n')}`;
  }

  function wrap(element) {
    return new Proxy(element, {
      get(target, prop) {
        if (prop === 'textContent') return messageText(target);
        if (prop === '__raw') return target;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function isCallElement(el) {
    const raw = el.textContent || '';
    return raw.includes('mcp_call') && !raw.includes('<server>')
      && !el.closest(USER_SEL) && !el.querySelector(USER_SEL) && !el.closest('form');
  }

  const inDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  class ChatGPTAdapter extends WMB.BaseAdapter {
    #cache = null;

    constructor() {
      super({
        id: 'chatgpt',
        name: 'ChatGPT',
        selectors: {
          composer: [
            '#prompt-textarea',
            'div.ProseMirror[contenteditable="true"]',
            'form div[contenteditable="true"]',
            'textarea[name="prompt-textarea"]',
            'textarea[data-id="root"]',
            'form textarea',
          ],
          sendButton: [
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
            'form button[type="submit"]',
          ],
          assistantMessages: [
            '[data-message-author-role="assistant"]',
            'article[data-turn="assistant"]',
            '[data-turn="assistant"]',
            'div.agent-turn',
          ],
          stopButton: [
            'button[data-testid="stop-button"]',
            'button[aria-label*="Stop streaming" i]',
            'button[aria-label*="Stop generating" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com';
    }

    getAssistantMessages() {
      const now = Date.now();
      if (this.#cache && now - this.#cache.time < CACHE_MS) return this.#cache.list;

      const containers = new Set();
      for (const selector of this.selectors.assistantMessages) {
        try { document.querySelectorAll(selector).forEach((el) => containers.add(el)); } catch { /* invalid selector */ }
      }
      const known = [...containers].filter((el) => !el.closest(USER_SEL) && !el.querySelector(USER_SEL));
      const extras = this.#callElements().filter((el) => !known.some((c) => c.contains(el)));

      const all = [...known, ...extras];
      const list = all
        .filter((el) => !all.some((other) => other !== el && other.contains(el)))
        .sort(inDocumentOrder)
        .map(wrap);
      this.#cache = { time: now, list };
      return list;
    }

    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastDone = '';
      const done = new Map();
      const seen = new WeakMap();
      const say = (message) => { try { this.debug?.('ok', `ChatGPT · ${message}`); } catch { /* no panel */ } };
      const convOf = () => (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null;
      let conv = convOf();

      const scan = () => {
        const now = Date.now();

        const nowConv = convOf();
        if (nowConv !== conv) {
          if (conv !== null) { done.clear(); this.lastActivity = 0; lastDone = ''; }
          conv = nowConv;
        }

        const streaming = this.isStreaming();
        if (streaming) this.lastActivity = now;
        if (streaming && this.lastDeliveryAt) this.genSinceDelivery = true;
        const baseline = now - this.lastActivity >= ACTIVE_MS;

        const tally = new Map();
        const present = new Set();
        const blocks = this.#callElements().sort(inDocumentOrder);
        for (const el of blocks) {
          const text = extractText(el);
          let state = seen.get(el);
          if (!state || state.text !== text) { state = { text, since: now }; seen.set(el, state); }
          const calls = parseCalls(text);
          if (!calls.length) continue;
          const stableFor = now - state.since;
          const ready = baseline || (stableFor >= STABLE_MS && (!streaming || stableFor >= STUCK_MS));

          calls.forEach((call, n) => {
            const hash = WMB.hash(JSON.stringify(call));
            const occurrence = tally.get(hash) ?? 0;
            tally.set(hash, occurrence + 1);
            const id = `${hash}:${occurrence}`;
            present.add(id);
            if (!ready) return;
            let fireId = id;
            if (done.has(id)) {
              if (baseline || streaming || n !== 0 || el !== blocks[blocks.length - 1] || !this.genSinceDelivery) return;
              fireId = `${id}~r${this.deliveries}`;
              if (done.has(fireId)) return;
              present.add(fireId);
            }
            done.set(fireId, { absentSince: 0 });
            if (!baseline && n === 0) { say('call detected, executing…'); callback({ id: fireId, call, element: wrap(el) }); }
          });
        }

        for (const [id, entry] of done) {
          if (present.has(id)) entry.absentSince = 0;
          else if (!entry.absentSince) entry.absentSince = now;
          else if (now - entry.absentSince >= FORGET_MS) done.delete(id);
        }

        if (!baseline && !streaming && onDone) {
          const messages = this.getAssistantMessages();
          let last = -1;
          for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
          if (last >= 0) {
            const text = messages[last].textContent;
            const key = `${conv}:${messages.length}:${text.length}`;
            const probe = seen.get(messages[last].__raw) ?? { text: '', since: now };
            if (probe.text !== text) seen.set(messages[last].__raw, { text, since: now });
            else if (now - probe.since >= STABLE_MS && key !== lastDone && !parseCalls(text).length) {
              lastDone = key; onDone({ text, element: messages[last] });
            }
          }
        }
      };
      this.rescan = () => { lastDone = ''; scan(); };

      const schedule = (delay = 400) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };
      const observer = new MutationObserver(() => schedule());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      (async () => {
        while (alive) {
          await WMB.sleep(POLL_MS);
          if (!WMB.extensionAlive()) alive = false;
          if (!alive) break;
          scan();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    #callElements() {
      const found = Array.from(document.querySelectorAll('pre')).filter(isCallElement);

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/mcp_call|"server"\s*:/.test(node.nodeValue) || node.nodeValue.includes('<server>')) continue;
        let el = node.parentElement;
        if (!el || el.closest(USER_SEL) || el.closest('form') || el.closest('[contenteditable="true"]')) continue;
        for (let depth = 0; el && depth < 10 && el !== document.body && el.tagName !== 'MAIN'; depth += 1, el = el.parentElement) {
          if (el.querySelector(USER_SEL)) break;
          if (!isCallElement(el)) continue;
          if (parseCalls(extractText(el)).length) {
            if (!found.some((f) => f === el || f.contains(el))) found.push(el);
            break;
          }
        }
      }
      return found.filter((el) => !found.some((other) => other !== el && el.contains(other) && !other.matches('pre')));
    }
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();
