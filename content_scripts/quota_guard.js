/**
 * quota_guard.js (isolated world, claude.ai only).
 * Receives the usage-limit readings posted by quota_page_hook.js and exposes WMB.quota.
 * WMB.quota.check() returns true when the 5h session or the weekly window has reached the stop threshold
 * (default 99%) or is exhausted. The threshold can be changed with localStorage key wmbx:quota-stop-pct.
 * The halt clears by itself when a later reading is below the threshold or the window reset time passes.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.quota) return;

  let stopPct = 99;
  try {
    const saved = Number(localStorage.getItem('wmbx:quota-stop-pct'));
    if (saved > 0 && saved <= 100) stopPct = saved;
  } catch (e) { /* storage unavailable */ }

  const q = { session: null, weekly: null, at: 0, halted: false, reason: '', stopPct, onChange: null };
  const names = { session: 'session (5h)', weekly: 'weekly' };
  const pct = (w) => (w.exceeded ? 100 : w.utilization * 100);

  q.check = () => {
    const now = Date.now();
    let reason = '';
    for (const key of ['session', 'weekly']) {
      const w = q[key];
      if (!w || w.resetTime <= now) continue;
      const p = pct(w);
      if (p >= stopPct) {
        reason = 'Claude ' + names[key] + ' usage at ' + Math.round(p) + '% (resets ' + new Date(w.resetTime).toLocaleString() + ')';
        break;
      }
    }
    const halted = reason !== '';
    const changed = halted !== q.halted;
    q.halted = halted;
    q.reason = reason;
    if (changed && typeof q.onChange === 'function') {
      try { q.onChange(halted, reason); } catch (e) { /* noop */ }
    }
    return halted;
  };

  q.waitFresh = async (since, maxMs) => {
    const end = Date.now() + maxMs;
    while (q.at < since && Date.now() < end) await WMB.sleep(100);
    return q.check();
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.source !== 'wmbx-quota') return;
    if (d.session) q.session = d.session;
    if (d.weekly) q.weekly = d.weekly;
    q.at = Date.now();
    q.check();
  });

  WMB.quota = q;
})();
