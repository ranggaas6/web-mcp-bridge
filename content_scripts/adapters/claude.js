/**
 * claude.js — Adapter for Claude Web (claude.ai).
 * The editor is ProseMirror (contenteditable).
 *
 * Fix: the aria-labels of claude.ai are localized (Indonesian: «Kirim pesan», «Hentikan respons»).
 * With English-only selectors the click on the send button was never intercepted
 * (so no instructions were injected) and the stop button was never detected.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  class ClaudeAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'claude',
        name: 'Claude',
        selectors: {
          composer: [
            'div[contenteditable="true"].ProseMirror',
            '[data-testid="chat-input"]',
            'fieldset div[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
          ],
          sendButton: [
            'button[aria-label="Send message"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Kirim" i]',
            'button[aria-label*="Envoyer" i]',
            'button[aria-label*="Enviar" i]',
            'button[aria-label*="Senden" i]',
            'button[data-testid="send-button"]',
          ],
          assistantMessages: [
            '.font-claude-response',
            '.font-claude-message',
            '[data-testid="assistant-message"]',
            'div[data-is-streaming]',
          ],
          stopButton: [
            'button[aria-label="Stop response"]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Hentikan" i]',
            'button[aria-label*="Berhenti" i]',
            'button[data-testid="stop-button"]',
            'div[data-is-streaming="true"]',
          ],
        },
      });
    }

    matches(hostname) {
      return hostname === 'claude.ai';
    }
  }

  WMB.registerAdapter(new ClaudeAdapter());
})();
