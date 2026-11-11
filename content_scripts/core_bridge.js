/**
 * core_bridge.js — Main controller in each chat tab.
 *
 * Fork: namespace `wmbx` in sessionStorage, injection mark and Web Lock
 * to coexist with the original extension in the same tab.
 *
 * Fork addition: per-host toggle. Each tab only injects/calls tools when
 * `settings.bridgeEnabled` is true AND `settings.hostEnabled[location.hostname]`
 * is not false. The widget shows a small switch so the user can flip the
 * current host without opening the popup.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.started) return;
  const adapter = WMB.findAdapter(location.hostname);
  if (!adapter) return;
  WMB.started = true;

  const INJECT_KEY = 'wmbx:injected-signature';
  const TURNS_KEY = 'wmbx:turns-since-full';
  const HEARTBEAT_MS = 10_000;
  const TOOL_TIMEOUT_MS = 150_000;
  const DELIVER_TIMEOUT_MS = 120_000;
  const DENIAL = /no tengo acceso|no puedo acceder|no tengo (la )?capacidad de (acceder|ejecutar|controlar)|no puedo (ejecutar|controlar|ver tu|abrir)|no dispongo de (acceso|herramientas)|no tengo herramientas|i (don'?t|do not) have (access|tools)|i (can'?t|cannot|am unable to) (access|control|run|execute|see your)/i;

  const HOST = location.hostname.toLowerCase();

  const slugKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const guarded = (promise, ms, message) => Promise.race([promise, WMB.sleep(ms).then(() => { throw new Error(message); })]);

  const state = {
    servers: [],
    tools: [],
    settings: { autoSend: true, maxResultChars: 12000 },
    hostEnabled: true,
    forceFull: false,
  };
  let queue = Promise.resolve();
  let lastRefreshError = '';

  try { navigator.locks?.request('wmbx-alive', () => new Promise(() => {})).catch(() => {}); } catch { /* noop */ }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return { ok: false, error: /context invalidated/i.test(err.message) ? 'The extension was updated: reload the tab.' : err.message };
    }
  }

  const isActive = () => state.settings.bridgeEnabled !== false && state.hostEnabled !== false;

  const widget = new WMB.Widget({
    onInject: () => injectInstructions(),
    onRefresh: () => { adapter.rescan(); return refresh(true); },
    onToggleBridge: async (value) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { bridgeEnabled: value } });
      await refresh();
    },
    onToggleHost: async (value) => {
      await send({ type: 'UPDATE_HOST_ENABLED', host: HOST, enabled: value });
      await refresh();
      widget.log('ok', value ? `Bridge enabled on ${HOST}.` : `Bridge disabled ONLY on ${HOST}. Other tabs are not affected.`);
    },
    onBridgeAction: async (action) => {
      const labels = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };
      widget.update({ bridgeBusy: action });
      widget.log('ok', `${labels[action] ?? 'Processing'} the bridge…`);
      const res = await send({ type: 'BRIDGE_GLOBAL', action });
      widget.update({ bridgeBusy: null });
      if (res?.ok) widget.log('ok', { start: 'Bridge turned on.', stop: 'Bridge turned off.', restart: 'Bridge restarted.' }[action] ?? 'Done.');
      else widget.log('err', res?.error ?? 'Could not complete the action.');
      await refresh();
    },
    onSetDelay: async (ms) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { responseDelayMs: ms } });
      await refresh();
    },
    onRescan: () => { adapter.forceRescan(); widget.log('ok', 'Rescanning the last AI response…'); },
    onSetPermission: async (id, permission) => {
      await send(id ? { type: 'SET_PERMISSION', id, permission } : { type: 'SET_ALL_PERMISSIONS', permission });
      await refresh();
    },
  });

  adapter.debug = (kind, message) => widget.log(kind, message);

  function injectionStatus() {
    if (document.body.textContent.includes(`[WMBX:${WMB.toolsSignature(state.tools)}]`)) return 'ok';
    return sessionStorage.getItem(INJECT_KEY) ? 'stale' : 'none';
  }

  async function refresh(announce = false) {
    const [snapshot, active] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_ACTIVE_TOOLS' })]);
    if (!snapshot?.ok || !active?.ok) {
      const error = snapshot?.error || active?.error || 'Could not contact the extension.';
      if (error !== lastRefreshError) widget.log('err', error);
      lastRefreshError = error;
      return;
    }
    lastRefreshError = '';
    state.settings = snapshot.settings;
    state.hostEnabled = snapshot.settings?.hostEnabled?.[HOST] !== false;
    state.servers = snapshot.servers.filter((s) => s.enabled && s.url);
    state.tools = active.tools;
    WMB.tools = state.tools;
    adapter.configure({ focusFallback: state.settings.focusFallback !== false });
    widget.update({
      adapterName: adapter.name,
      host: HOST,
      hostEnabled: state.hostEnabled,
      servers: state.servers,
      toolCount: state.tools.length,
      bridgeEnabled: state.settings.bridgeEnabled,
      bridge: snapshot.bridge ?? null,
      responseDelayMs: state.settings.responseDelayMs ?? 1500,
      injection: injectionStatus(),
    });
    if (announce) widget.log('ok', `Updated: ${state.tools.length} active tools.`);
  }

  const resetTurns = () => sessionStorage.setItem(TURNS_KEY, '0');

  async function injectInstructions() {
    await refresh();
    if (!isActive()) {
      widget.log('err', state.settings.bridgeEnabled === false
        ? 'The bridge is disabled (master switch). Enable it first.'
        : `The bridge is disabled ONLY on ${HOST}. Enable it in this platform's panel.`);
      return;
    }
    if (!state.tools.length) {
      widget.log('err', 'No tools: add an MCP in the popup, check that it is connected and not blocked.');
      return;
    }
    const result = await adapter.injectSystemPrompt(state.tools);
    if (result.ok) {
      sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
      resetTurns();
      state.forceFull = false;
      widget.update({ injection: 'ok' });
      widget.log('ok', 'Instructions written in the chat. Add your request and send.');
    } else {
      widget.log('err', result.error);
    }
  }

  const MIN_GAP_MS = 1200;
  let lastDeliveredAt = 0;
  async function paceDelivery() {
    const wanted = Math.min(60_000, Math.max(0, Number(state.settings.responseDelayMs) || 0));
    const gap = Math.max(0, MIN_GAP_MS - (Date.now() - lastDeliveredAt));
    const wait = Math.max(wanted, gap);
    if (wait < 400) return;
    if (wanted >= 800) widget.log('ok', `Waiting ${(wait / 1000).toFixed(1)} s before responding (adjusts in the panel).`);
    await WMB.sleep(wait);
  }

  async function deliver(srv, call, { status, text, raw, note }) {
    const { autoSend, maxResultChars, reminder } = state.settings;
    await paceDelivery();
    const plan = WMB.planResult(raw ?? { content: [{ type: 'text', text }] }, { server: srv.slug, name: call.name, status, maxChars: maxResultChars });

    let attached = true;
    if (plan.files.length) {
      widget.log('ok', `Attaching ${plan.files.length} file(s) to the chat…`);
      attached = await adapter.attachFiles(plan.files);
      if (!attached) {
        for (const file of plan.files.filter((f) => !f.overflow)) {
          try { WMB.dom.download(WMB.dom.fileFrom(file)); } catch { /* noop */ }
        }
        widget.log('err', 'Could not attach to chat: file downloaded (drag it to the chat).');
      }
    }
    const tail = reminder !== false && state.tools.length ? `\n${WMB.reminderLine(state.tools, 'result')}` : '';
    const message = `${plan.build(attached)}${note ? `\n${note}` : ''}${tail}`;
    const sent = await adapter.sendToolResult(message, { autoSend, settleMs: attached && plan.files.length ? 1500 : 0 });
    lastDeliveredAt = Date.now();
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `Result sent to ${adapter.name}.` : sent.error);
    return { ok: sent.ok, message };
  }

  async function resolveCall(call) {
    const find = () => {
      const wanted = slugKey(call.server);
      const srv = call.server
        ? state.servers.find((s) => s.slug === call.server || slugKey(s.slug) === wanted || slugKey(s.name) === wanted)
        : (state.servers.length === 1 ? state.servers[0] : null);
      return { srv, tool: srv ? state.tools.find((t) => t.name === call.name && t.server === srv.slug) : null };
    };
    let found = find();
    if (!found.srv || (!found.tool && found.srv.permission !== 'deny')) {
      await refresh();
      found = find();
    }
    return found;
  }

  let callSeq = 0;
  const REPEAT_WINDOW_MS = 15 * 60 * 1000;
  const MAX_REPEATS = 4;
  const recentCalls = new Map();

  async function handleCall(detected) {
    if (detected.malformed) return handleMalformed(detected);
    badStreak = 0;
    const { call } = detected;
    if (!isActive()) return;
    const obsolete = () => detected.seq !== undefined && detected.seq !== callSeq;
    if (obsolete()) { widget.log('err', `Obsolete call discarded (${call.name}): there is something newer in the chat.`); return; }
    const { srv, tool } = await resolveCall(call);

    if (!srv) {
      widget.log('err', `Call ignored: server «${call.server ?? '?'}» not active.`);
      return;
    }

    const repeatKey = WMB.hash(JSON.stringify([srv.slug, call.name, call.arguments ?? {}]) ?? '');
    const prev = recentCalls.get(repeatKey);
    const repeats = prev && Date.now() - prev.at < REPEAT_WINDOW_MS ? prev.count : 0;
    if (repeats >= MAX_REPEATS && prev.result && tool && srv.permission !== 'deny') {
      const cached = { ...prev.result, note: `[WMBX] IDENTICAL call repeated ${repeats + 1} times in a row: it was not executed again. This is the result of the last execution; use it. If it doesn't help, change the arguments or ask the user for something else.` };
      widget.log('err', `Identical call repeated ${repeats + 1} times: resending last result without executing.`);
      prev.count += 1;
      prev.at = Date.now();
      await guarded(deliver(srv, call, cached), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
      return;
    }

    let result;
    if (srv.permission === 'deny') {
      result = { status: 'rejected', text: 'The user does not allow using this MCP.' };
      widget.log('err', `Blocked: ${srv.slug} › ${call.name}`);
    } else if (!tool) {
      const available = state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
      result = { status: 'error', text: `Tool «${call.name}» does not exist in «${srv.slug}». Available: ${available || 'none'}.` };
    } else {
      let approved = true;
      if (srv.permission === 'ask') {
        const answer = await widget.requestApproval({ server: srv.slug, name: call.name, arguments: call.arguments });
        approved = Boolean(answer);
        if (answer === 'always') {
          await send({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' });
          await refresh();
        }
      }

      if (!approved) {
        result = { status: 'rejected', text: 'The user rejected the execution of this tool.' };
        widget.log('err', `Rejected: ${srv.slug} › ${call.name}`);
      } else {
        widget.log('ok', `Executing ${srv.slug} › ${call.name}…`);
        let response;
        try {
          response = await callWithRetry(srv, call, 'The tool took too long to respond.');
        } catch (err) {
          response = { ok: false, error: err.message };
        }
        if (!response?.ok) result = { status: 'error', text: response?.error ?? 'Unknown error.' };
        else result = { status: response.result?.isError ? 'error' : 'ok', raw: response.result };
        widget.log(result.status === 'ok' ? 'ok' : 'err', `${call.name}: ${result.status}`);
      }
    }
    if (tool && srv.permission !== 'deny' && result.status !== 'rejected') {
      recentCalls.set(repeatKey, { count: repeats + 1, at: Date.now(), result });
      if (repeats > 0) result.note = `[WMBX] This call is identical to the previous one (there are ${repeats + 1} now). It was executed again and this is the CURRENT result; if you already have the data, do not repeat it.`;
    }
    if (detected.rerun) result.note = '[WMBX] Automatic resend: your previous message with the result did not get processed. This is the CURRENT result of your call; continue from here.';
    if (detected.extra > 0) result.note = `[WMBX] Only the first call was executed; ${detected.extra} more were ignored. Send ONE call per message and wait for the result.`;
    if (obsolete()) { widget.log('err', `Result of ${call.name} discarded: there is already something newer in the chat (not sending it to avoid repetition).`); return; }
    const delivered = await guarded(deliver(srv, call, result), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
    await superviseDelivery({ detected, message: delivered.message, sentOk: delivered.ok });
  }

  const REACT_WAIT_MS = 20_000;
  const VERIFY_ROUNDS = 3;
  const MAX_RERUNS = 2;
  let epoch = 0;

  async function waitForReaction(ms, mine) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (mine !== epoch || !isActive()) return 'cancelled';
      if (adapter.hasReacted()) return 'replied';
      await WMB.sleep(1000);
    }
    if (mine !== epoch) return 'cancelled';
    return adapter.hasReacted() ? 'replied' : 'timeout';
  }

  async function superviseDelivery({ detected, message, sentOk }) {
    if (!state.settings.autoSend || !message) return;
    const mine = ++epoch;
    let sent = sentOk;
    for (let round = 1; round <= VERIFY_ROUNDS; round += 1) {
      if (sent) {
        if ((await waitForReaction(REACT_WAIT_MS, mine)) !== 'timeout') return;
        widget.log('err', `The AI did not react to the result (check ${round}/${VERIFY_ROUNDS}): sending it again.`);
      } else {
        widget.log('err', `The result did not go out to the chat (check ${round}/${VERIFY_ROUNDS}): sending it again.`);
      }
      if (mine !== epoch) return;
      sent = (await adapter.sendToolResult(message, { autoSend: true, settleMs: 0 })).ok;
    }
    if (sent && (await waitForReaction(REACT_WAIT_MS, mine)) !== 'timeout') return;
    if (mine !== epoch || !isActive()) return;
    const reruns = detected.reruns ?? 0;
    if (reruns >= MAX_RERUNS) {
      widget.log('err', 'Still no response from the AI after resending and re-executing. Check the chat.');
      return;
    }
    widget.log('err', `No reaction after ${VERIFY_ROUNDS} checks: executing the JSON left by the AI again (${reruns + 1}/${MAX_RERUNS}).`);
    queue = queue.then(() => processCall({ ...detected, rerun: true, reruns: reruns + 1, extra: 0 }));
  }

  let badStreak = 0;
  const MAX_BAD_STREAK = 3;
  const CONN_ERR = /no est.{1,2} conectado|desconectado/i;

  async function handleMalformed({ text }) {
    if (!isActive() || !state.tools.length) return;
    badStreak += 1;
    if (badStreak > MAX_BAD_STREAK) {
      widget.log('err', 'The AI repeats an invalid format: I will stop warning it. Check the chat.');
      return;
    }
    widget.log('err', `Unreadable block (${badStreak}/${MAX_BAD_STREAK}): checking that the AI has finished before warning it.`);
    await paceDelivery();
    const again = adapter.getLastText();
    if (adapter.isStreaming() || again !== text || WMB.extractMcpCalls(again).length) {
      badStreak = Math.max(0, badStreak - 1);
      widget.log('ok', 'The AI was still writing the block: I won\'t interrupt it with a warning.');
      return;
    }
    widget.log('err', 'The block is still unreadable: warning the AI with the reason.');
    const sent = await adapter.sendToolResult(WMB.formatCallError(text), { autoSend: state.settings.autoSend });
    if (!sent.ok) widget.log('err', sent.error);
  }

  async function waitConnected(srv, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const snap = await send({ type: 'GET_STATE' });
      if (snap?.servers?.find((s) => s.id === srv.id)?.status === 'connected') return true;
      await WMB.sleep(2000);
    }
    return false;
  }

  async function callWithRetry(srv, call, timeoutMessage) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments }), TOOL_TIMEOUT_MS, timeoutMessage);
      if (response?.ok || !CONN_ERR.test(response?.error ?? '') || attempt === 2) break;
      widget.log('err', `${srv.slug} disconnected: waiting for reconnection and retrying (${attempt + 1}/2).`);
      await send({ type: 'RECONNECT', id: srv.id });
      await waitConnected(srv, 40_000);
    }
    return response;
  }

  async function processCall(detected) {
    try {
      await handleCall(detected);
    } catch (err) {
      widget.log('err', `Error: ${err.message}`);
    }
  }

  let injecting = false;

  const hasInstructions = () => document.body.textContent.includes(`[WMBX:${WMB.toolsSignature(state.tools)}]`);

  function interceptSend(event) {
    if (!event.isTrusted || injecting) return;
    adapter.markActivity();
    epoch += 1;
    callSeq += 1;
    recentCalls.clear();
    const { bridgeEnabled, autoInject, reminder, reinjectEvery } = state.settings;
    if (!bridgeEnabled || state.hostEnabled === false || !state.tools.length) return;

    const present = hasInstructions();
    const turns = Number(sessionStorage.getItem(TURNS_KEY) || 0) + 1;
    const full = autoInject && (!present || state.forceFull || (reinjectEvery > 0 && turns >= reinjectEvery));
    const remind = !full && present && reminder !== false;
    if (!full && !remind) { sessionStorage.setItem(TURNS_KEY, String(turns)); return; }

    const composer = adapter.getComposer();
    const userText = composer ? WMB.dom.getText(composer).trim() : '';
    if (!userText) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    injecting = true;
    (async () => {
      const message = full
        ? `${WMB.buildSystemPrompt(state.tools)}\n\n---\n## User request\n${userText}`
        : `${userText}\n\n${WMB.reminderLine(state.tools)}`;
      if (await WMB.dom.setText(composer, message, { append: false })) {
        if (full) {
          sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
          resetTurns();
          state.forceFull = false;
          widget.update({ injection: 'ok' });
          widget.log('ok', present ? 'Instructions renewed in your message.' : 'Instructions automatically added to your message.');
        } else {
          sessionStorage.setItem(TURNS_KEY, String(turns));
        }
        await adapter.submit();
      } else {
        widget.log('err', 'Could not add instructions; use «Inject instructions».');
      }
    })().finally(() => { injecting = false; });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const composer = adapter.getComposer();
    if (composer && (composer === e.target || composer.contains(e.target))) interceptSend(e);
  }, true);

  window.addEventListener('click', (e) => {
    const button = adapter.getSendButton();
    if (button && e.target instanceof Node && button.contains(e.target)) interceptSend(e);
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'STATE_CHANGED') refresh();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());

  (async () => {
    while (WMB.extensionAlive()) {
      await WMB.sleep(HEARTBEAT_MS);
      try { await refresh(); } catch { /* el siguiente latido lo reintenta */ }
    }
  })();

  refresh().then(() => {
    adapter.observeResponses(
      (detected) => {
        epoch += 1;
        detected.seq = ++callSeq;
        queue = queue.then(() => processCall(detected));
      },
      {
        onDone: ({ text }) => {
          if (isActive() && state.tools.length && text.length < 1500 && DENIAL.test(text)) {
            state.forceFull = true;
            widget.log('err', 'The AI says it does not have access: I will renew the instructions on your next message.');
          }
        },
      },
    );
  });
})();
