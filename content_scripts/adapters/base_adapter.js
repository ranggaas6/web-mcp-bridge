/**
 * base_adapter.js — Base class for the Adapter pattern.
 *
 * Each platform (ChatGPT, Gemini, Claude) inherits from `BaseAdapter` and ONLY declares:
 *   - `matches(hostname)`
 *   - the DOM selectors (several candidates per element, in priority order)
 *   - optionally `getMessageKey()` if the site exposes a stable ID per message.
 *
 * Interface implemented by every adapter (inherited from this class):
 *   - injectSystemPrompt(activeToolsList)  → writes the instructions into the chat.
 *   - observeResponses(callback)           → detects `mcp_call` calls in responses.
 *   - attachFiles(files)                   → attaches images/files to the text box.
 *   - sendToolResult(text)                 → writes the result and simulates sending.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const BASELINE_MS = 2500;
  const DEBOUNCE_MS = 800;
  const POLL_MS = 1000;
  const WAKE_MS = 30_000;
  const STUCK_MS = 2500;
  const FRESH_CHAT_MS = 300_000;
  const STORE_KEY = 'wmbx:executed';
  const STORE_LIMIT = 500;
  const MALFORMED_STABLE_MS = 6000;

  class BaseAdapter {
    constructor({ id, name, selectors }) {
      this.id = id;
      this.name = name;
      this.selectors = selectors;
      this.executed = this.#loadExecuted();
      this.deliveries = 0;
      this.lastDeliveryAt = 0;
      this.genSinceDelivery = false;
      this.msgsAtDelivery = 0;
      this.baselineUntil = 0;
      this.lastActivity = 0;
      this.freshChat = false;
      this.awaitingSince = 0;
      this.options = { focusFallback: true };
      this.pendingReply = false;
      this.msgsAtSend = 0;
      this.pathAtSend = '';
      this.lastSendAt = 0;
      this.rescan = () => {};
      this.malformedStableMs = MALFORMED_STABLE_MS;
      this.sendSnap = null;
    }

    configure(options) { Object.assign(this.options, options); }

    matches(_hostname) { return false; }

    // ───────────── DOM access ─────────────

    getComposer() { return WMB.firstVisible(this.selectors.composer, document, { loose: true }); }
    getSendButton() { return WMB.firstVisible(this.selectors.sendButton, document, { loose: true }); }
    getAssistantMessages() { return WMB.allMatches(this.selectors.assistantMessages); }
    isStreaming() { return WMB.exists(this.selectors.stopButton); }

    getMessageKey(element, index) {
      const holder = element.closest('[data-message-id], [data-turn-id]') ?? element;
      return holder.getAttribute('data-message-id') || holder.getAttribute('data-turn-id') || `${location.pathname}:${index}`;
    }

    markActivity() {
      this.lastActivity = Date.now();
      this.awaitingSince = this.lastActivity;
      this.freshChat = this.getAssistantMessages().length === 0;
      this.#expectReply();
    }

    // ───────────── Public interface ─────────────

    async injectSystemPrompt(activeToolsList) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 4000 });
      if (!composer) return { ok: false, error: 'Chat text box not found.' };
      const ok = await WMB.dom.setText(composer, WMB.buildSystemPrompt(activeToolsList), { append: true });
      return ok ? { ok: true } : { ok: false, error: 'Could not write into the text box.' };
    }

    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastTick = 0;
      let lastSig = '';
      let lastText = '';
      let lastDone = '';
      let stableSince = Date.now();
      this.baselineUntil = Date.now() + BASELINE_MS;

      const schedule = (delay = DEBOUNCE_MS) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };

      const scan = () => {
        const now = Date.now();
        const streaming = this.isStreaming();
        const messages = this.getAssistantMessages();
        if (this.lastDeliveryAt && (streaming || messages.length > this.msgsAtDelivery)) this.genSinceDelivery = true;
        if (streaming) {
          this.lastActivity = now;
          this.baselineUntil = 0;
          if (messages.length <= 1) this.freshChat = true;
        } else if (messages.length > 2) this.freshChat = false;
        if (!messages.length) return;

        let last = -1;
        for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
        const text = last >= 0 ? messages[last].textContent : '';
        if (text !== lastText) { lastText = text; stableSince = now; this.awaitingSince = 0; }

        if (streaming && now - stableSince < STUCK_MS) { schedule(1000); return; }

        const expecting = this.pendingReply && now - this.lastSendAt < 300_000 && messages.length > this.msgsAtSend
          && (location.pathname === this.pathAtSend || this.freshChat);
        const baseline = now < this.baselineUntil && !expecting;
        const sig = `${location.pathname}|${messages.length}|${last}|${text.length}`;
        if (!baseline && sig === lastSig) return;
        lastSig = sig;

        if (!baseline && !streaming && this.pendingReply && messages.length > this.msgsAtSend && now - stableSince >= STUCK_MS) this.pendingReply = false;

        const indexes = baseline ? messages.map((_, i) => i) : (last >= 0 ? [last] : []);
        for (const i of indexes) {
          const element = messages[i];
          const calls = WMB.extractMcpCalls(i === last ? text : element.textContent || '');
          calls.forEach((call, n) => {
            if (!baseline && !this.#isFresh(messages, text)) { this.debug?.('err', 'Call ignored: this is the same message as before (no new AI response).'); return; }
            let id = `${this.getMessageKey(element, i)}#${n}:${WMB.hash(JSON.stringify(call))}`;
            if (this.executed.has(id)) {
              if (baseline || i !== last || streaming || n !== 0 || !this.genSinceDelivery) return;
              id = `${id}~r${this.deliveries}`;
              if (this.executed.has(id)) return;
            }
            this.#remember(id);
            if (!baseline && n === 0) callback({ id, call, element, extra: calls.length - 1 });
          });
          const looksBad = !baseline && i === last && !calls.length && !streaming && Boolean(WMB.looksMalformed?.(text));
          const quiet = now - stableSince >= this.malformedStableMs;
          if (looksBad && !quiet) lastSig = '';
          if (looksBad && quiet) {
            const badId = `${this.getMessageKey(element, i)}#bad:${WMB.hash(text)}`;
            if (!this.executed.has(badId)) { this.#remember(badId); callback({ id: badId, malformed: true, text, element }); }
          }
          if (!baseline && i === last && !calls.length && !streaming && onDone) {
            const doneKey = `${this.getMessageKey(element, i)}:${text.length}`;
            if (doneKey !== lastDone) { lastDone = doneKey; onDone({ text, element }); }
          }
        }
      };
      this.rescan = () => { lastSig = ''; lastDone = ''; scan(); };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastTick > 300) {
          lastTick = now;
          if (this.isStreaming()) { this.lastActivity = now; this.baselineUntil = 0; }
        }
        schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      let href = location.href;
      (async () => {
        while (alive) {
          const idle = !this.awaitingSince && Date.now() - this.lastActivity > 60_000;
          await WMB.sleep(idle ? POLL_MS * 3 : POLL_MS);
          if (!WMB.extensionAlive()) alive = false;
          if (!alive) break;
          if (location.href !== href) {
            href = location.href;
            if (this.freshChat && Date.now() - this.lastActivity < FRESH_CHAT_MS) this.freshChat = false;
            else this.baselineUntil = Date.now() + BASELINE_MS;
          }
          scan();
          await this.#wakeIfStale();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    async #wakeIfStale() {
      if (!this.awaitingSince || !this.options.focusFallback || !document.hidden || this.isStreaming()) return;
      if (Date.now() - this.awaitingSince < WAKE_MS || this.wokeFor === this.awaitingSince) return;
      this.wokeFor = this.awaitingSince;
      const token = await WMB.bg({ type: 'FOCUS_TAB' });
      await WMB.sleep(1500);
      this.rescan();
      if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
    }

    async attachFiles(files) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return false;
      let list;
      try { list = files.map(WMB.dom.fileFrom); } catch { return false; }

      const root = composer.closest('form, fieldset') ?? composer.parentElement?.parentElement?.parentElement ?? composer;
      const before = root.getElementsByTagName('*').length;
      const grew = async () => {
        for (let i = 0; i < 10; i += 1) {
          await WMB.sleep(300);
          if (root.getElementsByTagName('*').length - before >= 3) return true;
        }
        return false;
      };
      const transfer = () => {
        const dt = new DataTransfer();
        list.forEach((file) => dt.items.add(file));
        return dt;
      };

      this.lastActivity = Date.now();
      composer.focus();
      try {
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true }));
        if (await grew()) return true;
      } catch { /* next method */ }
      try {
        const dataTransfer = transfer();
        for (const type of ['dragenter', 'dragover', 'drop']) {
          composer.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
        }
        if (await grew()) return true;
      } catch { /* next method */ }
      try {
        const inputs = Array.from(document.querySelectorAll(this.selectors.fileInput?.join(',') || 'input[type="file"]'));
        const input = inputs.find((el) => !el.webkitdirectory && (!el.accept || /image|\*/.test(el.accept))) ?? inputs[0];
        if (input) {
          input.files = transfer().files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (await grew()) return true;
        }
      } catch { /* no more methods */ }
      return false;
    }

    async sendToolResult(text, { autoSend = true, settleMs = 0 } = {}) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return { ok: false, error: 'Chat text box not found.' };
      this.lastActivity = Date.now();
      this.deliveries += 1;
      this.lastDeliveryAt = Date.now();
      this.genSinceDelivery = false;
      this.msgsAtDelivery = this.getAssistantMessages().length;
      this.#expectReply();
      try {
        if (await WMB.dom.purgeStale(composer)) this.debug?.('err', 'A stale result was still unsent in the text box: removed it to avoid duplication.');
      } catch { /* if it cannot be cleaned, continue as before */ }
      if (!(await WMB.dom.setText(composer, text, { append: true }))) {
        return { ok: false, error: 'Could not write into the text box.' };
      }
      if (!autoSend) return { ok: true };
      if (settleMs) await WMB.sleep(settleMs);

      const marker = this.#marker(text);
      let sent = false;
      for (let n = 1; n <= 3 && !sent; n += 1) {
        if (n > 1) {
          await WMB.sleep(1200);
          const now = this.getComposer();
          if (!now || (marker && !this.#norm(WMB.dom.getText(now)).includes(marker))) { sent = true; break; }
          this.debug?.('err', `Send ${n}/3: the chat did not accept the message; trying another method…`);
        }
        const token = n === 3 && this.options.focusFallback && WMB.isBackground() ? await WMB.bg({ type: 'FOCUS_TAB' }) : null;
        if (token) await WMB.sleep(800);
        sent = (await this.#attemptSend(n, n === 1 && settleMs ? 30_000 : 4000)) && (await this.#confirmSent(text));
        if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
      }
      if (sent) this.awaitingSince = Date.now();
      return sent ? { ok: true } : { ok: false, error: 'Could not send to the chat after 3 automatic attempts.' };
    }

    async #confirmSent(text) {
      const marker = this.#marker(text);
      return Boolean(await WMB.waitFor(() => {
        const composer = this.getComposer();
        if (!composer) return true;
        const current = this.#norm(WMB.dom.getText(composer));
        return current.trim().length < 10 || !marker || !current.includes(marker);
      }, { timeout: 8000, interval: 250 }));
    }

    #norm(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
    #marker(text) { return this.#norm(text).slice(0, 60); }

    hasReacted() {
      return this.genSinceDelivery || this.isStreaming() || this.getAssistantMessages().length > this.msgsAtDelivery;
    }

    async #attemptSend(n, timeout) {
      if (n === 1) return this.submit(timeout);
      const composer = this.getComposer();
      if (!composer) return false;
      composer.focus();
      try { composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '' })); } catch { /* noop */ }
      await WMB.sleep(250);
      const press = (extra = {}) => {
        const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...extra };
        for (const type of ['keydown', 'keypress', 'keyup']) composer.dispatchEvent(new KeyboardEvent(type, init));
      };
      const consumed = () => { const c = this.getComposer(); return !c || !WMB.dom.getText(c).trim(); };
      const clickButton = () => {
        const b = this.getSendButton();
        if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') b.click();
      };
      if (n === 2) {
        press();
        if (await WMB.waitFor(consumed, { timeout: 900, interval: 150 })) return true;
        clickButton();
        return true;
      }
      press({ ctrlKey: true });
      if (await WMB.waitFor(consumed, { timeout: 900, interval: 150 })) return true;
      try { composer.closest('form')?.requestSubmit?.(); } catch { /* noop */ }
      if (await WMB.waitFor(consumed, { timeout: 900, interval: 150 })) return true;
      clickButton();
      return true;
    }
    #expectReply() {
      this.pendingReply = true;
      this.lastSendAt = Date.now();
      this.msgsAtSend = this.getAssistantMessages().length;
      this.pathAtSend = location.pathname;
      this.sendSnap = this.#snapshot();
    }

    #snapshot() {
      const messages = this.getAssistantMessages();
      const hashes = new Set();
      for (const el of messages) { const t = (el.textContent || '').trim(); if (t) hashes.add(WMB.hash(t)); }
      return { count: messages.length, hashes, path: location.pathname };
    }

    #isFresh(messages, text) {
      const s = this.sendSnap;
      if (!s || s.path !== location.pathname) return true;
      if (!s.hashes.has(WMB.hash(String(text).trim()))) return true;
      return messages.length === s.count + 1;
    }

    getLastText() {
      const messages = this.getAssistantMessages();
      for (let i = messages.length - 1; i >= 0; i -= 1) if ((messages[i].textContent || '').trim()) return messages[i].textContent;
      return '';
    }

    forget(id) {
      this.executed.delete(id);
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT))); } catch { /* noop */ }
    }

    forceRescan() {
      this.baselineUntil = 0;
      this.genSinceDelivery = true;
      this.sendSnap = null;
      this.rescan();
    }

    async submit(timeout = 4000) {
      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 120 });
      if (button) { button.click(); return true; }

      const composer = this.getComposer();
      if (!composer) return false;
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    }

    // ───────────── Executed IDs (persist in the tab) ─────────────

    #loadExecuted() {
      try { return new Set(JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]')); } catch { return new Set(); }
    }

    #remember(id) {
      this.executed.add(id);
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT)));
      } catch { /* storage unavailable */ }
    }
  }

  WMB.BaseAdapter = BaseAdapter;
  WMB.adapters = [];
  WMB.registerAdapter = (adapter) => { WMB.adapters.push(adapter); };
  WMB.findAdapter = (hostname) => WMB.adapters.find((a) => a.matches(hostname)) ?? null;
})();
