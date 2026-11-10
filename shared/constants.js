/**
 * constants.js - Constantes compartidas entre el service worker y el popup.
 * Fork: namespace storage dan port berbeda para instalacion lado a lado.
 */

/** Máximo de servidores MCP activos a la vez. */
export const MAX_ACTIVE_SERVERS = 5;

/** Número recomendado de servidores activos (más = más tokens de contexto). */
export const RECOMMENDED_ACTIVE_SERVERS = 1;

/**
 * Namespace de storage propio del fork.
 * Prefijo `wmbx_` para no colisionar con la extension original (`wmb_`).
 * Chrome aisla storage por extension, pero un namespace distinto evita
 * confusion al exportar/importar configuracion y al depurar en DevTools.
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

/** Permisos por MCP: allow = nunca pregunta · ask = pregunta en cada llamada · deny = bloqueado. */
export const PERMISSIONS = ['allow', 'ask', 'deny'];
export const PERMISSION_LABELS = { allow: 'Permitir siempre', ask: 'Preguntar siempre', deny: 'No permitir' };

/**
 * Puerto de control por defecto del fork.
 * Original: 8099. Fork: 8199. Asi los dos puentes pueden coexistir.
 */
export const DEFAULT_CONTROL_PORT = 8199;

/** Puerto del lanzador (start_bridge_loop.pyw) del fork. */
export const DEFAULT_LAUNCHER_PORT = 8198;

export const DEFAULT_SETTINGS = {
  /** Interruptor general: si está en false no hay conexiones ni inyección. */
  bridgeEnabled: true,
  /** Añade las instrucciones de las herramientas automáticamente al enviar el primer mensaje. */
  autoInject: true,
  /** Permiso que reciben los MCP nuevos (y el que muestra el selector global). */
  defaultPermission: 'ask',
  /** Enviar automáticamente el resultado al chat. */
  autoSend: true,
  /** Máximo de caracteres de un resultado dentro del mensaje. Lo que lo supere se adjunta COMPLETO como archivo (nunca se recorta). */
  maxResultChars: 12000,
  /** Añade una línea corta a cada mensaje para que la IA no olvide que tiene herramientas locales. */
  reminder: true,
  /** Cada N mensajes del usuario se vuelven a enviar las instrucciones completas (0 = nunca). */
  reinjectEvery: 12,
  /** Si el chat no acepta el envío con la pestaña oculta, trae la pestaña al frente un instante y vuelve a la anterior. */
  focusFallback: true,
  /** Detecta solos los servidores de servers.json preguntando al puente (control port). */
  autoDiscover: true,
  /** Activa también los servidores detectados (hasta el máximo). Si es false solo se activa el primero cuando no hay ninguno activo. */
  autoEnableDiscovered: false,
  /** Puerto de control del puente del fork. */
  controlPort: DEFAULT_CONTROL_PORT,
  /** Muestra los avisos del autor del fork. */
  showNotices: true,
  /** Pausa (ms) antes de entregar cada resultado al chat. */
  responseDelayMs: 1500,
};

/** Límites del tiempo de respuesta configurable (ms). */
export const RESPONSE_DELAY_MAX_MS = 60_000;

/** El servidor de prueba incluido en el repositorio (server/examples/demo_mcp_server.py). */
export const DEMO_SERVER = { name: 'demo', url: 'ws://localhost:8090' };

/**
 * Avisos del autor: ahora apunta al repo fork, no al upstream.
 */
export const NOTICES_URL = 'https://raw.githubusercontent.com/ranggaas6/web-mcp-bridge/main/notices.json';
export const NOTICES_EVERY_MS = 10 * 60 * 1000;
export const NOTICES_RETRY_MS = 5 * 60 * 1000;
export const NOTICES_MAX_BYTES = 64 * 1024;
export const NOTICES_MAX_ITEMS = 20;
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
