/**
 * native_host.js — Pemicu bridge berdasarkan tab AI yang didukung.
 *
 * Bridge (mcp_ws_bridge.py) hanya hidup selama ada minimal satu tab AI yang
 * didukung terbuka: chatgpt.com, gemini.google.com, claude.ai, atau
 * chat.deepseek.com. Modul ini mengirim perintah start/stop ke native host
 * (com.ranggaas6.easy_vibe) yang dipasang oleh installer Easy-Vibe.
 *
 * Sebelumnya hanya tab chat.deepseek.com yang memicu bridge. Sekarang daftar
 * host diambil dari SUPPORTED_URL_PATTERNS (shared/constants.js) sehingga
 * ChatGPT, Gemini, Claude, dan DeepSeek semuanya memicu bridge secara otomatis.
 */
import { SUPPORTED_URL_PATTERNS } from '../shared/constants.js';

const HOST_NAME = 'com.ranggaas6.easy_vibe';

let port = null;
let triggerTabCount = 0;
let started = false;
let userStopped = false;

async function countTriggerTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_URL_PATTERNS });
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
  const count = await countTriggerTabs();
  if (count > 0 && !started && !userStopped) {
    if (sendNative('start')) started = true;
  } else if (count === 0 && started) {
    if (sendNative('stop')) started = false;
    userStopped = false;
  }
  triggerTabCount = count;
}

globalThis.wmbxNative = {
  isAvailable: () => !!ensurePort(),
  start: () => {
    userStopped = false;
    if (sendNative('start')) started = true;
    return true;
  },
  stop: () => {
    userStopped = true;
    if (sendNative('stop')) started = false;
    return true;
  },
  restart: () => {
    userStopped = true;
    sendNative('stop');
    started = false;
    setTimeout(() => {
      userStopped = false;
      if (sendNative('start')) started = true;
    }, 2000);
    return true;
  },
};

chrome.tabs.onCreated.addListener(() => { reconcileTabs().catch(() => {}); });
chrome.tabs.onRemoved.addListener(() => { reconcileTabs().catch(() => {}); });
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') reconcileTabs().catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => { reconcileTabs().catch(() => {}); });

reconcileTabs().catch(() => {});
