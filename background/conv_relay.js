/**
 * conv_relay.js - meneruskan perekam percakapan (content script) ke control port bridge.
 * Sengaja terpisah dari native_host.js: kegagalan di sini tidak bisa menghentikan bridge.
 * Hanya menerima koneksi dari tab claude.ai milik ekstensi ini.
 */
const CONTROL = 'http://127.0.0.1:8199';
const TIMEOUT_MS = 15000;

chrome.runtime.onConnect.addListener((cp) => {
  if (cp.name !== 'wmbx-conv') return;
  if (!(cp.sender && typeof cp.sender.url === 'string' && cp.sender.url.startsWith('https://claude.ai/'))) return;
  cp.onMessage.addListener(async (m) => {
    const reply = (res) => { try { cp.postMessage({ rid: m && m.rid, ...res }); } catch { /* port closed */ } };
    if (!m || (m.op !== 'state' && m.op !== 'append')) { reply({ ok: false, error: 'op tidak dikenal' }); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(CONTROL + '/conv/' + m.op, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.body || {}),
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => null);
      reply(data && typeof data === 'object' ? data : { ok: false, error: 'HTTP ' + r.status });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    } finally {
      clearTimeout(timer);
    }
  });
});
