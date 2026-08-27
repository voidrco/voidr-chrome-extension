const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 60 * 1000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_SIZE = 1024 * 1024 * 1024;

const NETWORK_TYPES = new Set(['fetch', 'fetchError', 'xhr', 'xhrError', 'resource']);
const IDENTIFIER_PARENT_SEGMENTS = new Set([
  'account',
  'accounts',
  'cliente',
  'clientes',
  'customer',
  'customers',
  'order',
  'orders',
  'pedido',
  'pedidos',
  'reset',
  'session',
  'sessions',
  'token',
  'user',
  'users',
]);

function privacySafePathname(pathname) {
  const rawSegments = String(pathname || '/').split('/');
  const segments = rawSegments.map((segment, index) => {
    if (!segment) return '';
    const decoded = (() => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })();
    const previous = (() => {
      try {
        return decodeURIComponent(rawSegments[index - 1] || '').toLowerCase();
      } catch {
        return String(rawSegments[index - 1] || '').toLowerCase();
      }
    })();
    const looksSensitive =
      IDENTIFIER_PARENT_SEGMENTS.has(previous) ||
      decoded.includes('@') ||
      /^\d{4,}$/.test(decoded) ||
      /^[0-9a-f]{16,}$/i.test(decoded) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded) ||
      /^[A-Za-z0-9_-]{24,}$/.test(decoded);
    return looksSensitive ? ':id' : encodeURIComponent(decoded).replace(/%3A/gi, ':');
  });
  const normalized = segments.join('/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maxLength);
}

function boundedNumber(value, minimum, maximum, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

// Reject host-supplied secrets before they can enter the durable recording.
export function sanitizeExternalNetworkEvent(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  let parsed;
  try {
    parsed = new URL(String(input.url || ''));
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  const url = `${parsed.origin}${privacySafePathname(parsed.pathname)}`.slice(0, 2000);
  if (!url) return null;

  const requestedType = boundedText(input.type, 24);
  const type = NETWORK_TYPES.has(requestedType) ? requestedType : 'resource';
  const requestedMethod = boundedText(input.method, 16).trim().toUpperCase();
  const method = /^[A-Z]{1,16}$/.test(requestedMethod) ? requestedMethod : 'GET';
  const suppliedTimestamp = Number(input.timestamp);
  const timestamp = Number.isFinite(suppliedTimestamp)
    ? boundedNumber(suppliedTimestamp, now - MAX_EVENT_AGE_MS, now + MAX_EVENT_FUTURE_SKEW_MS, now)
    : now;
  const requestId = boundedText(input.requestId, 160).replace(/[^A-Za-z0-9._:-]/g, '_');

  return {
    type,
    ...(requestId ? { requestId } : {}),
    timestamp,
    url,
    method,
    status: boundedNumber(input.status, 0, 599),
    statusText: boundedText(input.statusText, 200),
    duration: boundedNumber(input.duration ?? input.durationMs, 0, MAX_DURATION_MS),
    contentType: boundedText(input.contentType, 120).split(';')[0].trim(),
    responseSize: boundedNumber(input.responseSize, 0, MAX_RESPONSE_SIZE),
    requestSize: 0,
  };
}
