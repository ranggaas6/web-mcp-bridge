/**
 * deepseek.js — Adapter for DeepSeek (chat.deepseek.com).
 *
 * DeepSeek UI particulars:
 *   - The text box is a plain <textarea id="chat-input"> (React): `dom.setText` already handles it.
 *   - The send button has NO aria-label or stable class: it is an icon (`ds-icon-button`) at the end of the bar.
 *     While generating, THAT SAME button becomes "stop": so here it is sent with Enter, and the button is only
 *     clicked if we know generation is not running (otherwise a click would CANCEL the response).
 *   - Responses render in `.ds-markdown`. With "DeepThink" the reasoning also uses Markdown and sometimes
 *     contains a draft of the `mcp_call`: it is excluded so it does not run twice.
 *   - There is no stable per-message ID.
 *
 * Anti-loop (the same result was sent over and over):
 *   1. Call ID by CONTENT (conversation + how many earlier messages carry the same call), not by message
 *      position: if DeepSeek repaints or changes the number of `.ds-markdown` blocks, the call is not "renewed".
 *   2. Lock: after running a call, another IDENTICAL one is ignored until the result is sent and the AI replies again.
 *   3. Safe send: "send" is not clicked if a generation is in progress, nor if the box is already empty (it went out).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  /** "Reasoning" blocks (DeepThink): their text does not count as the answer. */
  const THINK_SEL = '.ds-think-content, [class*="think" i], [class*="reasoning" i]';
  /** Short header that precedes the reasoning ("Thought for 5 seconds", …). */
  const THINK_HEADER = /^(thought|thinking|deepthink|razon|reasoning)/i;
  /** Icon buttons (send, attach, stop) and, as an alternative, any ARIA button. */
  const ICON_BUTTONS = ['div[role="button"].ds-icon-button', 'button.ds-icon-button', '.ds-icon-button'];
  const ANY_BUTTONS = ['div[role="button"]', 'button'];

  const GROW_MS = 2000;
  const FRESH_CHAT_MS = 120_000;
  const LOCK_SENT_MS = 90_000;
  const LOCK_MAX_MS = 240_000;

  const convId = () => (location.pathname.match(/\/s\/([^/?#]+)/) || [])[1] || null;
  const hashOf = (call) => WMB.hash(JSON.stringify(call) ?? '');

  function isThinking(el) {
    if (el.closest(THINK_SEL) || el.querySelector(THINK_SEL)) return true;
    for (let node = el, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      const head = (node.previousElementSibling?.textContent || '').trim();
      if (head && head.length < 45 && THINK_HEADER.test(head)) return true;
    }
    return false;
  }

  class DeepSeekAdapter extends WMB.BaseAdapter {
    #conv = convId();
    #tag = this.#conv ?? `h${Date.now()}`;
    #hashCache = new WeakMap();
    #lock = null;
    #grow = { el: null, len: 0, at: 0 };

    constructor() {
      super({
        id: 'deepseek',
        name: 'DeepSeek',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea[placeholder*="DeepSeek" i]',
            'textarea[placeholder*="Message" i]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            'div[role="button"][aria-label*="Send" i]',
            'button[aria-label*="Send" i]',
          ],
          assistantMessages: ['.ds-markdown'],
          stopButton: [
            'div[role="button"][aria-label*="Stop" i]',
            'button[aria-label*="Stop" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com');
    }

    // ───────────── Conversation ─────────────

    #syncConversation() {
      const id = convId();
      if (id === this.#conv) return;
      const freshChatGotUrl = this.#conv === null && id !== null && Date.now() - this.lastActivity < FRESH_CHAT_MS;
      this.#conv = id;
      if (!freshChatGotUrl) this.#tag = id ?? `h${Date.now()}`;
    }

    // ───────────── Assistant messages (without reasoning) ─────────────

    getAssistantMessages() {
      this.#syncConversation();
      const found = super.getAssistantMessages();
      const answers = found.filter((el) => !isThinking(el));
      const list = answers.length || !found.length ? answers : found;
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }

    /** Hashes of the message's MCP calls (cached by text). */
    #callHashes(el) {
      const text = el.textContent || '';
      const hit = this.#hashCache.get(el);
      if (hit && hit.text === text) return hit.set;
      const set = new Set(WMB.extractMcpCalls(text).map(hashOf));
      this.#hashCache.set(el, { text, set });
      return set;
    }

    /**
     * Key by CONTENT: conversation + number of earlier messages that carry the same call.
     * It does not depend on message position, so page repaints do not "renew" an executed call.
     */
    getMessageKey(element, index) {
      const mine = this.#callHashes(element);
      if (!mine.size) return super.getMessageKey(element, index);
      this.#syncConversation();
      let before = 0;
      for (const other of this.getAssistantMessages()) {
        if (other === element) break;
        for (const hash of this.#callHashes(other)) if (mine.has(hash)) { before += 1; break; }
      }
      return `${this.#tag}|${before}`;
    }

    // ───────────── Generation in progress ─────────────

    isStreaming() {
      let streaming = WMB.exists(this.selectors.stopButton);
      if (!streaming) {
        const messages = this.getAssistantMessages();
        const last = messages[messages.length - 1] ?? null;
        const len = last ? (last.textContent || '').length : 0;
        const now = Date.now();
        if (last && last === this.#grow.el && len > this.#grow.len) this.#grow.at = now;
        this.#grow.el = last;
        this.#grow.len = len;
        streaming = now - this.#grow.at < GROW_MS;
      }
      if (streaming && this.#lock?.sentAt) this.#lock.newGen = true;
      return streaming;
    }

    // ───────────── Anti-duplicate lock ─────────────

    #locked(hash) {
      const lock = this.#lock;
      if (!lock || lock.hash !== hash) return false;
      const now = Date.now();
      const expired = lock.sentAt ? (lock.newGen || now - lock.sentAt > LOCK_SENT_MS) : now - lock.firedAt > LOCK_MAX_MS;
      if (expired) { this.#lock = null; return false; }
      return true;
    }

    observeResponses(callback, options) {
      return super.observeResponses((detected) => {
        if (detected.malformed || !detected.call) { callback(detected); return; }
        const hash = hashOf(detected.call);
        if (this.#locked(hash) && detected.id === this.#lock?.id) { this.debug?.('ok', 'DeepSeek · identical call already in progress: ignored'); return; }
        this.#lock = { hash, id: detected.id, firedAt: Date.now(), sentAt: 0, newGen: false };
        callback(detected);
      }, options);
    }

    async sendToolResult(text, options) {
      try {
        return await super.sendToolResult(text, options);
      } finally {
        if (this.#lock && !this.#lock.sentAt) this.#lock.sentAt = Date.now();
      }
    }

    // ───────────── Send ─────────────

    /** Icon button (no text) furthest right in the composer bar. */
    #composerButtons() {
      const composer = this.getComposer();
      if (!composer) return [];
      let node = composer.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        for (const group of [ICON_BUTTONS, ANY_BUTTONS]) {
          const buttons = [];
          for (const selector of group) {
            try { node.querySelectorAll(selector).forEach((b) => { if (!buttons.includes(b)) buttons.push(b); }); } catch { /* noop */ }
          }
          const icons = buttons
            .filter((b) => !b.closest('.ds-toggle-button') && !(b.textContent || '').trim() && b.querySelector('svg, img, i'))
            .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          if (icons.length) return icons;
        }
      }
      return [];
    }

    getSendButton() {
      const labelled = WMB.firstVisible(this.selectors.sendButton, document, { loose: true });
      if (labelled) return labelled;
      const buttons = this.#composerButtons();
      return buttons.length ? buttons[buttons.length - 1] : null;
    }

    async submit(timeout = 4000) {
      const composer = this.getComposer();
      if (!composer) return false;
      const hasText = () => WMB.dom.getText(composer).trim().length > 0;
      if (!hasText()) return true;

      if (this.isStreaming()) {
        const idle = await WMB.waitFor(() => !this.isStreaming(), { timeout, interval: 200 });
        if (!idle) return false;
      }
      const gone = () => !hasText();

      composer.focus();
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keypress', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;

      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 150 });
      if (button && hasText() && !this.isStreaming()) {
        button.click();
        if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;
      }
      return !hasText();
    }
  }

  WMB.registerAdapter(new DeepSeekAdapter());
})();
