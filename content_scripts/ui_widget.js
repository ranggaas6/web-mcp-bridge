/**
 * ui_widget.js — Floating panel inside the page (Shadow DOM, no style conflicts).
 *
 * Shows active MCP status, lets you inject instructions and choose the permission
 * for each MCP (always allow · always ask · block). With "ask" it requests
 * APPROVAL before each tool (human-in-the-loop).
 *
 * Fork addition: a per-host switch so each AI site (ChatGPT, Gemini, Claude, DeepSeek)
 * can be enabled or disabled independently, without touching the other tabs.
 *
 * Fork addition: tabs to separate the main settings from the log view.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) el.setAttribute(key, value);
    }
    for (const child of children.flat()) el.append(child?.nodeType ? child : document.createTextNode(child ?? ''));
    return el;
  };

  const PERMS = [['allow', 'Always allow'], ['ask', 'Always ask'], ['deny', 'Block']];

  const CSS = `
    :host { all: initial; }
    .wrap {
      --bg:#ffffff; --fg:#16211d; --muted:#67736d; --line:#dde2dc; --accent:#0f766e; --accent-fg:#fff;
      --ok:#16a34a; --warn:#d97706; --err:#dc2626;
      position: fixed; left: var(--x, 16px); top: var(--y, auto); bottom: var(--y, 16px); z-index: 2147483647;
      touch-action: none; user-select: none;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg:#1b2326; --fg:#e6ece9; --muted:#91a09a; --line:#2c373b; --accent:#2dd4bf; --accent-fg:#062a27; }
    }
    .pill, .panel { background: var(--bg); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0,0,0,.18); }
    .pill {
      display: flex; gap: 8px; align-items: center; padding: 7px 12px; border-radius: 999px;
      cursor: grab; color: inherit; font: inherit;
    }
    .wrap.dragging .pill { cursor: grabbing; }
    .wrap.dragging { transition: none !important; }
    .wrap:not(.dragging) { transition: left .12s ease, top .12s ease; }
    .wrap.flip { flex-direction: column-reverse; }
    .wrap.flip .panel { margin-bottom: 4px; }
    @media (prefers-reduced-motion: reduce) { .wrap:not(.dragging) { transition: none; } }
    .panel { max-width: calc(100vw - 24px); max-height: min(80vh, calc(100vh - 40px)); }
    .pill.alert { border-color: var(--warn); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
    .panel { width: 340px; max-height: 80vh; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; border-radius: 12px; padding: 12px 14px; }
    .panel > * { flex: none; }
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .head strong { font-size: 14px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 8px; flex: none; }
    .tab-btn { flex: 1; text-align: center; padding: 6px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; font-size: 13px; font-weight: 500; }
    .tab-btn:hover { background: rgba(127,127,127,.1); }
    .tab-btn.active { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
    .log-view { display: flex; flex-direction: column; flex: 1; min-height: 250px; overflow: hidden; }
    .log-view ul { flex: 1; overflow-y: auto; margin: 0; padding: 0; border: none; }
    .muted { color: var(--muted); font-size: 12px; }
    ul { list-style: none; margin: 6px 0; padding: 0; display: grid; gap: 4px; }
    li.srv { display: flex; gap: 8px; align-items: center; }
    .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    button { font: inherit; cursor: pointer; border-radius: 8px; padding: 6px 10px; border: 1px solid var(--line); background: transparent; color: var(--fg); }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
    button.danger { color: var(--err); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button:disabled { opacity: .55; cursor: default; }
    .bridge { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
    .bridge .state { display: inline-flex; gap: 6px; align-items: center; }
    .bridge .row button { flex: 1; }
    .host-toggle { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
    .host-toggle .host-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .host-toggle .host-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .host-toggle .host-label strong { font-size: 12px; }
    .host-toggle .host-label small { font-size: 11px; color: var(--muted); }
    .host-toggle button.host { min-width: 84px; }
    .host-toggle button.host.on { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
    .host-toggle.off .host-label small { color: var(--warn); }
    .card { margin: 8px 0; padding: 10px; border: 1px solid var(--warn); border-radius: 10px; }
    .card pre {
      margin: 6px 0; padding: 8px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      background: rgba(127,127,127,.12); border-radius: 6px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
    }
    .approvals { flex: none; }
    .approvals .card { margin: 0 0 8px; }
    .panel.has-approval .card pre { max-height: 96px; }
    .approvals .queue { margin: 0 0 8px; text-align: center; }
    .panel.has-approval .bridge { margin-top: 4px; }
    .log { font-size: 12px; color: var(--muted); }
    .log .err { color: var(--err); } .log .ok { color: var(--ok); }
    .perm { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 12px; }
    select { font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
    select.allow { border-color: var(--ok); } select.deny { border-color: var(--err); }
    li.srv .grow { flex: 1; min-width: 0; }
    .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); text-align: center; font-size: 11px; color: var(--muted); }
  `;

  const MAX_LOGS = 200;

  class Widget {
    constructor(handlers) {
      this.handlers = handlers;
      this.model = {
        adapterName: '', servers: [], toolCount: 0, injection: 'none',
        bridgeEnabled: true, bridge: null, bridgeBusy: null, responseDelayMs: 1500,
        host: '', hostEnabled: true,
      };
      this.logs = [];
      this.approvals = [];
      this.open = false;
      this.activeTab = 'main';
      this.selectFocusedAt = 0;

      this.host = document.createElement('div');
      this.host.id = 'wmbx-host';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.root = h('div', { class: 'wrap' });
      this.shadow.append(h('style', {}, CSS), this.root);
      document.documentElement.append(this.host);
      this.#initDrag();
      this.render();
    }

    // ═════════════════════════════ Drag ═════════════════════════════
    #posKey() { return `wmbx-widget-pos:${location.origin}${location.pathname}`; }

    #applyPosition(pos) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
        this.root.style.removeProperty('--x');
        this.root.style.removeProperty('--y');
        return;
      }
      const w = this.root.getBoundingClientRect().width || 0;
      const hgt = this.root.getBoundingClientRect().height || 0;
      const x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - w));
      const y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - hgt));
      this.root.style.setProperty('--x', `${x}px`);
      this.root.style.setProperty('--y', `${y}px`);
      this.root.style.setProperty('bottom', 'auto');
    }

    #savePosition(x, y) {
      try { sessionStorage.setItem(this.#posKey(), JSON.stringify({ x, y })); } catch { /* storage unavailable */ }
    }

    #resetPosition() {
      try { sessionStorage.removeItem(this.#posKey()); } catch { /* noop */ }
      this.root.style.removeProperty('--x');
      this.root.style.removeProperty('--y');
      this.root.style.removeProperty('bottom');
    }

    #fitToViewport() {
      const r = this.root.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let dx = 0, dy = 0;
      if (r.right > vw) dx -= (r.right - vw);
      if (r.left < 0) dx -= r.left;
      if (r.bottom > vh) dy -= (r.bottom - vh);
      if (r.top < 0) dy -= r.top;
      if (dx === 0 && dy === 0) return;
      const nx = r.left + dx;
      const ny = r.top + dy;
      this.root.style.setProperty('--x', `${Math.round(nx)}px`);
      this.root.style.setProperty('--y', `${Math.round(ny)}px`);
      this.root.style.setProperty('bottom', 'auto');
    }

    #initDrag() {
      requestAnimationFrame(() => {
        try {
          const raw = sessionStorage.getItem(this.#posKey());
          if (raw) this.#applyPosition(JSON.parse(raw));
        } catch { /* ignore */ }
        window.addEventListener('resize', () => {
          const raw = sessionStorage.getItem(this.#posKey());
          if (!raw) return;
          try { const pos = JSON.parse(raw); this.#applyPosition(pos); } catch { /* ignore */ }
        }, { passive: true });
      });

      this.root.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
      this.root.addEventListener('dblclick', (e) => {
        if (e.target.closest('.pill')) { this.#resetPosition(); }
      });
    }

    #onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      let handle = e.target.closest('.pill');
      if (!handle) {
        const head = e.target.closest('.head[data-drag]');
        if (head && !e.target.closest('button, select, input, a, textarea')) handle = head;
      }
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = this.root.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origX = rect.left, origY = rect.top;
      let moved = false;
      this.root.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch { /* old browsers */ }

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        this.root.style.setProperty('--x', `${Math.round(origX + dx)}px`);
        this.root.style.setProperty('--y', `${Math.round(origY + dy)}px`);
        this.root.style.setProperty('bottom', 'auto');
        this.#fitToViewport();
      };
      const onUp = () => {
        try { handle.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        this.root.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        if (moved) {
          const r = this.root.getBoundingClientRect();
          this.#savePosition(r.left, r.top);
          this._suppressClickUntil = Date.now() + 250;
        }
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    }

    update(patch) { Object.assign(this.model, patch); this.render(); }

    log(kind, text) {
      this.logs.unshift({ kind, text, ts: new Date() });
      this.logs.length = Math.min(this.logs.length, MAX_LOGS);
      this.render();
    }

    /** Requests user confirmation. Resolves `true` (run), `'always'` (run and always allow) or `false` (reject). */
    requestApproval(call) {
      return new Promise((resolve) => {
        this.approvals.push({ call, resolve });
        this.open = true;
        this.render(true);
      });
    }

    render(force = false) {
      const visible = this.model.bridgeEnabled !== false;
      this.host.style.setProperty('display', visible ? '' : 'none', visible ? '' : 'important');
      if (!visible) { this.open = false; }
      if (!force && this.shadow.activeElement?.tagName === 'SELECT' && Date.now() - this.selectFocusedAt < 6000) return;
      const { servers, toolCount, hostEnabled } = this.model;
      const pending = this.approvals.length;
      const bridgeDown = Boolean(this.model.bridge?.checked && !this.model.bridge.online);
      const hostOff = hostEnabled === false;
      const activeLabel = !this.model.bridgeEnabled ? 'Bridge disabled'
        : hostOff ? `${this.model.host || 'This site'} off`
        : bridgeDown ? 'Bridge off'
        : servers.length ? `${servers.length} MCP · ${toolCount} tools`
        : 'No active MCPs';
      const allUp = servers.length > 0 && servers.every((s) => s.status === 'connected');

      const pill = h('button', {
        class: `pill${pending ? ' alert' : ''}`,
        'aria-expanded': String(this.open),
        onclick: () => { if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) return; this.open = !this.open; this.render(); },
      },
      h('i', { class: `dot ${pending ? 'warn' : allUp && this.model.bridgeEnabled && !hostOff ? 'ok' : ''}` }),
      h('span', {}, pending ? `${pending} call${pending > 1 ? 's' : ''} awaiting approval` : activeLabel));

      const logScroll = this.root.querySelector('ul.log')?.scrollTop ?? 0;
      this.root.replaceChildren(...(this.open ? [this.#panel()] : []), pill);
      const logList = this.root.querySelector('ul.log');
      if (logList && logScroll) logList.scrollTop = logScroll;
      if (this.open) requestAnimationFrame(() => this.#fitToViewport());
    }

    /** 3-state selector. `value` can be 'mixed' when MCPs have different permissions. */
    #permSelect(value, onChange, label) {
      const options = PERMS.map(([v, text]) => h('option', { value: v, selected: v === value ? '' : false }, text));
      if (value === 'mixed') options.unshift(h('option', { value: 'mixed', selected: '', disabled: '' }, 'Mixed'));
      return h('select', {
        class: value,
        'aria-label': label,
        onfocus: () => { this.selectFocusedAt = Date.now(); },
        onchange: (e) => { const { value: chosen } = e.target; e.target.blur(); onChange(chosen); },
        onblur: () => { this.selectFocusedAt = 0; this.render(true); },
      }, options);
    }

    /** Response delay selector (pause before delivering each result to the AI). */
    #delaySelect() {
      const current = Number(this.model.responseDelayMs) || 0;
      const steps = [[0, 'Instant'], [1000, '1 s'], [1500, '1.5 s'], [2000, '2 s'], [3000, '3 s'], [5000, '5 s'], [8000, '8 s'], [10000, '10 s'], [15000, '15 s'], [30000, '30 s']];
      if (!steps.some(([ms]) => ms === current)) steps.push([current, `${(current / 1000).toFixed(1)} s`]);
      steps.sort((a, b) => a[0] - b[0]);
      return h('select', {
        'aria-label': 'Response delay',
        title: 'Pause before returning each result to the AI. Raise it if the AI saturates or says "Too many requests".',
        onfocus: () => { this.selectFocusedAt = Date.now(); },
        onchange: (e) => { const ms = Number(e.target.value); e.target.blur(); this.handlers.onSetDelay?.(ms); },
        onblur: () => { this.selectFocusedAt = 0; this.render(true); },
      }, steps.map(([ms, text]) => h('option', { value: String(ms), selected: ms === current ? '' : false }, text)));
    }

    /**
     * Per-host switch.
     * Turning this off stops injection and tool calls ONLY on the current site.
     * Other tabs with other AI platforms keep working, and the master switch is untouched.
     */
    #hostSection() {
      const host = this.model.host || location.hostname;
      const enabled = this.model.hostEnabled !== false;
      const toggle = () => this.handlers.onToggleHost?.(!enabled);
      return h('div', { class: `host-toggle${enabled ? '' : ' off'}` },
        h('div', { class: 'host-row' },
          h('div', { class: 'host-label' },
            h('strong', {}, `Bridge on ${host}`),
            h('small', {}, enabled ? 'Injection and tools are active on this site.' : 'Injection and tools are OFF only on this site.')),
          h('button', {
            class: `host${enabled ? ' on' : ''}`,
            onclick: toggle,
            title: enabled
              ? 'Disable the bridge only on this site (other AI tabs are not affected)'
              : 'Enable the bridge only on this site',
          }, enabled ? 'Enabled' : 'Disabled')));
    }

    /** Global bridge control: start / stop / restart the PROCESS. */
    #bridgeSection() {
      const { bridge, bridgeBusy } = this.model;
      const checked = Boolean(bridge?.checked);
      const online = Boolean(bridge?.online);
      const busy = Boolean(bridgeBusy);
      const stateText = !checked ? 'checking…' : online ? `on${bridge.pid ? ` (pid ${bridge.pid})` : ''}` : 'off';
      const act = (action) => () => { if (!busy) this.handlers.onBridgeAction?.(action); };
      return h('div', { class: 'bridge' },
        h('div', { class: 'perm', style: 'margin-top:0' },
          h('strong', {}, 'Bridge (all sites)'),
          h('span', { class: 'muted state' }, h('i', { class: `dot ${online ? 'ok' : ''}` }), stateText)),
        h('div', { class: 'row' },
          online
            ? h('button', { class: 'danger', disabled: busy ? '' : false, onclick: act('stop') }, bridgeBusy === 'stop' ? 'Stopping…' : 'Stop')
            : h('button', { class: 'primary', disabled: busy ? '' : false, onclick: act('start') }, bridgeBusy === 'start' ? 'Starting…' : 'Start'),
          h('button', { disabled: busy ? '' : false, onclick: act('restart') }, bridgeBusy === 'restart' ? 'Restarting…' : (online ? 'Restart' : 'Restart / start'))),
        h('div', { class: 'perm' }, h('strong', {}, 'Response delay'), this.#delaySelect()));
    }

    #logSection() {
      return h('div', { class: 'log-view' },
        this.logs.length
          ? h('ul', { class: 'log' }, this.logs.map((l) => h('li', { class: l.kind },
              `${l.ts.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${l.text}`)))
          : h('p', { class: 'muted' }, 'No logs yet.')
      );
    }

    #panel() {
      const { servers, injection, adapterName } = this.model;
      const injectionText = {
        none: 'Instructions will be added automatically when you send your next message.',
        ok: 'Instructions injected and up to date.',
        stale: 'Active MCPs changed: inject the instructions again.',
      }[injection];
      const perms = new Set(servers.map((s) => s.permission));
      const common = perms.size === 1 ? [...perms][0] : 'mixed';

      const mainContent = [
        this.#approvalSection(),
        this.#hostSection(),
        servers.length
          ? h('ul', {}, servers.map((s) => h('li', { class: 'srv' },
            h('i', { class: `dot ${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : ''}` }),
            h('span', { class: 'grow' }, s.name, h('span', { class: 'muted' }, s.permission === 'deny' ? ' · blocked' : s.status === 'connected' ? ` · ${s.toolCount} tools` : ' · disconnected')),
            this.#permSelect(s.permission, (value) => this.handlers.onSetPermission(s.id, value), `Permission for ${s.name}`))))
          : h('p', { class: 'muted' }, 'Open the extension icon and enable an MCP server.'),
        servers.length > 1
          ? h('div', { class: 'perm' }, h('strong', {}, 'All MCPs'),
            this.#permSelect(common, (value) => this.handlers.onSetPermission(null, value), 'Permission for all MCPs'))
          : null,
        this.#bridgeSection(),
        h('p', { class: 'muted' }, injectionText),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => this.handlers.onInject() }, 'Inject instructions'),
          h('button', { onclick: () => this.handlers.onRefresh() }, 'Refresh'),
          h('button', { title: 'Re-reads the last AI response (if the tab was slow and missed it)', onclick: () => this.handlers.onRescan?.() }, 'Rescan')),
        h('div', { class: 'foot' }, h('div', {}, `Web MCP Bridge (Fork) v${WMB.VERSION}`), h('div', {}, 'GitHub: @ranggaas6/web-mcp-bridge'))
      ];

      return h('div', { class: `panel${this.approvals.length ? ' has-approval' : ''}`, role: 'dialog', 'aria-label': 'Web MCP Bridge' },
        h('div', { class: 'head', 'data-drag': '1', style: 'cursor: move;' },
          h('strong', {}, `Web MCP Bridge · ${adapterName}`),
          h('button', { 'aria-label': 'Close', onclick: () => { this.open = false; this.render(true); } }, '✕')),

        h('div', { class: 'tabs' },
          h('button', { class: `tab-btn${this.activeTab === 'main' ? ' active' : ''}`, onclick: () => { this.activeTab = 'main'; this.render(true); } }, 'Main'),
          h('button', { class: `tab-btn${this.activeTab === 'logs' ? ' active' : ''}`, onclick: () => { this.activeTab = 'logs'; this.render(true); } }, 'Logs')
        ),

        this.activeTab === 'logs' ? this.#logSection() : mainContent
      );
    }

    /** Approval always at the top (below header) so its buttons never fall out of the panel. */
    #approvalSection() {
      if (!this.approvals.length) return null;
      const rest = this.approvals.length - 1;
      return h('div', { class: 'approvals' },
        this.#approvalCard(this.approvals[0]),
        rest > 0 ? h('p', { class: 'muted queue' }, `+${rest} more in queue`) : null);
    }

    #approvalCard(item) {
      const { call } = item;
      const decide = (value) => {
        this.approvals = this.approvals.filter((a) => a !== item);
        item.resolve(value);
        this.render(true);
      };
      let args = JSON.stringify(call.arguments ?? {}, null, 2);
      if (args.length > 1500) args = `${args.slice(0, 1500)}\n…`;
      return h('div', { class: 'card' },
        h('strong', {}, 'The AI wants to run a tool'),
        h('div', {}, `${call.server} › ${call.name}`),
        h('pre', {}, args),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => decide(true) }, 'Run'),
          h('button', { onclick: () => decide('always') }, 'Always allow'),
          h('button', { class: 'danger', onclick: () => decide(false) }, 'Reject')));
    }
  }

  WMB.Widget = Widget;
})();
