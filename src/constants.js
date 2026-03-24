export const VOIDR_VERSION = '1.8.2';

// Default configuration for the collector
export const DEFAULT_CONFIG = {
  apiKey: null,
  applicationId: null,
  environment: null,
  collectorUrl: __VOIDR_COLLECTOR_URL__,
  sessionTimeout: 30, // minutes
  system: false,
  skipRecording: false,
  samplingRate: 0.1, // 0 to 1 (0% to 100%), default 10%
  dataMasking: {
    text: false,
    inputs: false,
    blockSelectors: ['[data-sensitivity="block"]'],
  },
  networkCapture: true,
  captureConsole: true,
  user: null,
  meta: null,
};

// HOTFIX: TASY-specific selector masking (remove after proper selector-based solution is deployed)
export const isTasy =
  typeof window !== 'undefined' &&
  window.location.hostname.includes('tasy');

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
export const BASE64_DATA_URL_REGEX =
  /^data:image\/[^;]+;base64,[A-Za-z0-9+/=]{1000,}/;
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
