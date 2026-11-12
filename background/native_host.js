/**
 * native_host.js — Pemicu bridge berdasarkan tab DeepSeek.
 *
 * Bridge (mcp_ws_bridge.py) hanya hidup selama ada tab chat.deepseek.com
 * yang terbuka. Modul ini mengirim perintah start/stop ke native host
 * (com.ranggaas6.easy_vibe) yang dipasang oleh installer Easy-Vibe.
 *
 * Native host menutup bridge saat port terputus (Brave ditutup) karena
 * stdin-nya mendapat EOF.
 */

const HOST_NAME = 'com.ranggaas6.easy_vibe';
const DEEPSEEK_PATTERN = 'https://chat.deepseek.com/*';

let port = null;
let deepseekTabCount = 0;
let started = false;

function isDeepseekUrl(url) {
  if (!url) return false;
  try { return new URL(url).hostname === 'chat.deepseek.com'; } catch { return false; }
}

async function countDeepseekTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: DEEPSEEK_PATTERN });
    return tabs.length;
  } catch { return 0; }
}

function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[WMB] native host terputus:', err.message);
      port = null;
      started = false;
    });
    port.onMessage.addListener((msg) => {
      if (msg && typeof msg === 'object') console.log('[WMB] native host:', msg);
    });
  } catch (err) {
    console.warn('[WMB] tidak bisa terhubung ke native host:', err?.message ?? err);
    port = null;
  }
  return port;
}

function sendNative(action) {
  const p = ensurePort();
  if (!p) return false;
  try {
    p.postMessage({ action });
    return true;
  } catch (err) {
    console.warn('[WMB] postMessage gagal:', err?.message ?? err);
    return false;
  }
}

async function reconcileTabs() {
  const count = await countDeepseekTabs();
  if (count > 0 && !started) {
    if (sendNative('start')) started = true;
  } else if (count === 0 && started) {
    if (sendNative('stop')) started = false;
  }
  deepseekTabCount = count;
}

chrome.tabs.onCreated.addListener(() => { reconcileTabs().catch(() => {}); });
chrome.tabs.onRemoved.addListener(() => { reconcileTabs().catch(() => {}); });
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') reconcileTabs().catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => { reconcileTabs().catch(() => {}); });

reconcileTabs().catch(() => {});
