/**
 * meta.js — Adapter for Meta AI (www.meta.ai).
 *
 * Meta AI renders JSON code blocks in a viewer with JSON / Tree / Raw tabs. The Tree view
 * collapses nested objects as "{1 key}", which hides the tool arguments (confirmed in DevTools).
 * Before reading a message we switch every collapsed viewer to its Raw tab.
 * Confirmed working: composer, send button, assistant message selector.
 * Not verified: stopButton, and the exact markup of the Raw tab (found by its visible label).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const COLLAPSED = /[0-9]+ keys?}/;
  const RAW_LABEL = /^raw$/i;
  const RETRY_MS = 1500;
  const lastClick = new WeakMap();

  /** If the viewer inside `el` shows the collapsed Tree, click its "Raw" tab. */
  function switchToRaw(el) {
    if (!COLLAPSED.test(el.textContent || '')) return;
    const now = Date.now();
    if (now - (lastClick.get(el) || 0) < RETRY_MS) return;
    lastClick.set(el, now);
    for (const node of el.querySelectorAll('*')) {
      if (node.children.length === 0 && RAW_LABEL.test((node.textContent || '').trim())) {
        const target = node.closest('[role="tab"], button, [role="button"]') || node;
        try { target.click(); } catch { /* noop */ }
      }
    }
  }

  class MetaAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'meta',
        name: 'Meta AI',
        selectors: {
          composer: [
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"][data-lexical-editor="true"]',
            'textarea[placeholder*="Ask" i]',
            'div[contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            'button[aria-label*="Send" i]',
            'div[role="button"][aria-label*="Send" i]',
          ],
          assistantMessages: [
            '[data-testid*="assistant" i]',
          ],
          stopButton: [
            'div[role="button"][aria-label*="Stop" i]',
            'button[aria-label*="Stop" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'meta.ai' || hostname.endsWith('.meta.ai');
    }

    getAssistantMessages() {
      const list = super.getAssistantMessages();
      list.forEach(switchToRaw);
      return list;
    }
  }

  WMB.registerAdapter(new MetaAdapter());
})();
