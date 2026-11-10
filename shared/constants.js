/**
 * constants.js - Constants shared between the service worker and popup.
 * Fork: dedicated storage namespace and ports so it can run side by side with upstream.
 */

/** Maximum number of active MCP servers at once. */
export const MAX_ACTIVE_SERVERS = 5;

/** Recommended number of active servers (more = more context tokens). */
export const RECOMMENDED_ACTIVE_SERVERS = 1;

/**
 * Fork-specific storage namespace.
 * `wmbx_` prefix avoids colliding with the original extension (`wmb_`).
 */
export const STORAGE_KEYS = {
  servers: 'wmbx_servers',
  settings: 'wmbx_settings',
  history: 'wmbx_history',
  dismissed: 'wmbx_dismissed',
  notices: 'wmbx_notices',
  bridge: 'wmbx_bridge',
};

export const LEGACY_STORAGE_KEYS = ['wmb_update', 'wmbx_update'];

/** Permissions per MCP: allow = never ask · ask = ask on every call · deny = blocked. */
export const PERMISSIONS = ['allow', 'ask', 'deny'];
export const PERMISSION_LABELS = { allow: 'Always allow', ask: 'Always ask', deny: 'Block' };

/**
 * Default control port of the fork.
 * Upstream uses 8099. Fork uses 8199, so both bridges can run simultaneously.
 */
export const DEFAULT_CONTROL_PORT = 8199;

/** Launcher port (start_bridge_loop.pyw) of the fork. */
export const DEFAULT_LAUNCHER_PORT = 8198;

export const DEFAULT_SETTINGS = {
  /** Master switch: when false there are no connections and no injection. */
  bridgeEnabled: true,
  /** Automatically add tool instructions when sending the first message. */
  autoInject: true,
  /** Permission given to new MCP servers (also used by the global selector). */
  defaultPermission: 'ask',
  /** Automatically send the result back to the chat. */
  autoSend: true,
  /** Maximum characters of a result kept inline. Anything larger is attached in full as a file (never truncated). */
  maxResultChars: 12000,
  /** Adds a short line to every message so the AI keeps remembering it has local tools. */
  reminder: true,
  /** Every N user messages the full instructions are re-sent (0 = never). */
  reinjectEvery: 12,
  /** If the chat refuses to send while the tab is hidden, bring the tab to the front briefly and restore focus. */
  focusFallback: true,
  /** Auto-detect servers from servers.json by querying the bridge (control port). */
  autoDiscover: true,
  /** Also enable detected servers (up to the maximum). If false only the first is enabled when none is active. */
  autoEnableDiscovered: false,
  /** Fork bridge control port. */
  controlPort: DEFAULT_CONTROL_PORT,
  /** Fork launcher port. Must match `launcher_port` in servers.json. */
  launcherPort: DEFAULT_LAUNCHER_PORT,
  /** Show the author's notices (what's new, updates, incidents). */
  showNotices: true,
  /** Delay (ms) before delivering each result to the chat. */
  responseDelayMs: 1500,
};

/** Bounds for the configurable response delay (ms). */
export const RESPONSE_DELAY_MAX_MS = 60_000;

/** Demo server shipped with the repository (server/examples/demo_mcp_server.py). */
export const DEMO_SERVER = { name: 'demo', url: 'ws://localhost:8190' };

/**
 * Author notices: public notices.json in the fork repo (no server of our own).
 */
export const NOTICES_URL = 'https://raw.githubusercontent.com/ranggaas6/web-mcp-bridge/main/notices.json';
export const NOTICES_EVERY_MS = 10 * 60 * 1000;
export const NOTICES_RETRY_MS = 5 * 60 * 1000;
export const NOTICES_MAX_BYTES = 64 * 1024;
export const NOTICES_MAX_ITEMS = 20;
/** Notice links may only point to these sites (https). */
export const NOTICE_LINK_HOSTS = ['github.com', 'gist.github.com'];
export const NOTICE_LINK_SUFFIXES = ['.github.io'];

export const PROTOCOL_VERSION = '2025-03-26';
export const CALL_TIMEOUT_MS = 120_000;
export const HISTORY_LIMIT = 50;

export const SUPPORTED_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
  'https://claude.ai/*',
  'https://chat.deepseek.com/*',
];
