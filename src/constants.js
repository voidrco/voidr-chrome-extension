export const VOIDR_VERSION = '1.17.1';

// Default configuration for the collector
export const DEFAULT_CONFIG = {
  apiKey: null,
  applicationId: null,
  environment: null,
  collectorUrl: __VOIDR_COLLECTOR_URL__,
  forcedSessionId: null,
  sessionTimeout: 30, // minutes
  idleTimeout: 5, // minutes of inactivity before auto-pausing recording
  system: false,
  skipRecording: false,
  samplingRate: 0.1, // 0 to 1 (0% to 100%), default 10%
  // When the session loses the samplingRate dice roll, keep recording into an
  // in-memory ring buffer and upgrade to a real session if an error occurs
  // (Sentry-style replaysOnErrorSampleRate). 0 disables buffer mode.
  onErrorSampleRate: 0,
  // Hard cap on a single session's duration. When reached the session is
  // finalized; with sessionRotation a fresh sessionId continues recording.
  maxSessionDurationMinutes: 60,
  sessionRotation: true,
  dataMasking: {
    text: false,
    inputs: false,
    blockSelectors: ['[data-sensitivity="block"]'],
  },
  // Coarse privacy level applied on top of dataMasking:
  // 'mask' | 'mask-user-input' | 'allow' | null (null = dataMasking only)
  privacyLevel: null,
  captureWebVitals: true,
  captureLongTasks: true,
  longTaskThresholdMs: 100,
  captureResourceErrors: true,
  captureCspViolations: true,
  uiHeuristics: {
    enabled: true,
    mutationThreshold: 250,
    debounceMs: 800,
    minSnapshotIntervalMs: 15000,
  },
  // White screen detection (web-see-style point sampling). Opt-in; skeleton
  // projects must set skeleton: true for accurate results.
  whiteScreen: {
    enabled: false,
    skeleton: false,
    containers: ['html', 'body', '#app', '#root'],
  },
  networkCapture: true,
  // Optional (event) => event|null hook to scrub URLs/bodies/headers before
  // buffering; return null to drop the request entirely.
  networkSanitizer: null,
  captureConsole: true,
  // ── Static resource capture (Phase 6) ─────────────────────────────────────
  // Capture img/script/css/font/other static assets via PerformanceObserver as
  // network events with type: 'resource'. OFF by default — high volume, opt-in.
  captureResources: false,
  // Hard cap on the number of resource events captured per session (volume guard).
  captureResourcesMaxPerSession: 200,
  // Per-entry sampling rate (0..1) applied when captureResources is enabled.
  captureResourcesSampleRate: 1,
  // Attach a top-level `traceId` from request correlation headers when present
  // (x-correlation-id / x-request-id / traceparent / x-trace-id). OFF by default.
  captureTraceId: false,
  // Inline icon/web fonts as data: URIs at record start (same-origin with
  // credentials, cross-origin via anonymous CORS) so they render in the replay
  // under its strict CSP. Set true to enable.
  inlineFonts: false,
  // Inline UNREADABLE cross-origin stylesheets (<link> without crossorigin)
  // as <style> tags at record start so the replay renders the layout. Set
  // true to enable.
  inlineStylesheets: false,
  // Capture a SessionEnvironmentBundle (localStorage/sessionStorage/cookies +
  // viewport/UA/URL) at recording start and refresh it on stop, shipped to a
  // dedicated collector endpoint for future local Playwright replay. OFF by
  // default — only extension-driven captures (which set this true) opt in. The
  // bundle contains secrets and is stored separately from replay-served data.
  captureEnvironmentBundle: false,
  user: null,
  meta: null,
};

// HOTFIX: TASY-specific selector masking (remove after proper selector-based solution is deployed)
export const isTasy = typeof window !== 'undefined' && window.location.hostname.includes('tasy');

export const TASY_MASK_SELECTORS = [
  '.grid-canvas-right',
  '.person-bar-field-info',
  '.person-info',
  '#datagrid',
];

// Network capture constants
export const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB

export const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
  'apikey',
  'password',
  'secret',
  'token',
  'credentials',
];

// Content types to capture (data communication, not files)
export const CAPTURABLE_CONTENT_TYPES = [
  'application/json',
  'application/xml',
  'text/xml',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/graphql',
  'application/graphql+json',
];

// Request headers that carry a trace/correlation id (checked when captureTraceId
// is enabled). Lower-cased; matched case-insensitively against request headers.
export const TRACE_ID_HEADERS = ['x-correlation-id', 'x-request-id', 'traceparent', 'x-trace-id'];

// Best-effort content-type guesses for static resources by file extension, used
// only when no response header is available (PerformanceResourceTiming exposes
// no headers). Bare MIME types — the decoder stores these verbatim.
export const RESOURCE_EXT_CONTENT_TYPES = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  json: 'application/json',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
};

// Content types to ignore (files, HTML, binaries)
export const IGNORED_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'image/',
  'audio/',
  'video/',
  'font/',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
];

// Base64 image compression thresholds
export const BASE64_DATA_URL_REGEX = /^data:image\/[^;]+;base64,[A-Za-z0-9+/=]{1000,}/;
export const MIN_BASE64_LENGTH = 100_000;

/**
 * Detect automation environments (Playwright, Selenium, Puppeteer, PhantomJS).
 * Returns true if the current browser is controlled by an automation framework.
 */
export function isAutomationEnvironment() {
  try {
    if (navigator.webdriver === true) return true;
    if (window.playwright !== undefined) return true;
    if (window.callPhantom || window._phantom) return true;
    if (window.__playwright || window.__puppeteer) return true;
    return false;
  } catch (e) {
    return false;
  }
}
