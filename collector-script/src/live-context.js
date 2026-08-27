import { state } from './state.js';

export const LIVE_CONTEXT_VERSION = 'VOIDR-LIVE-CONTEXT/1';
export const LIVE_CONTEXT_CATEGORIES = Object.freeze([
  'pages',
  'clicks',
  'requests',
  'errors',
  'notes',
  'voiceNotes',
]);

const RING_LIMIT = 100;
const READ_LIMIT = 50;
const STRING_LIMIT = 2000;
const HEADER_LIMIT = 50;
const HEADER_VALUE_LIMIT = 500;
const HEADER_TOTAL_LIMIT = 8000;
const OBJECT_ENTRY_LIMIT = 100;
const OBJECT_DEPTH_LIMIT = 4;
const CAUSAL_WINDOW_MS = 5000;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|session|credential|private[-_]?key/i;

const truncate = (value, limit = STRING_LIMIT) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

function sanitizeText(value, key = '') {
  if (value == null) return value;
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  return truncate(value)
    .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, `$1${REDACTED}`)
    .replace(/\beyJ[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}\.[a-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\b(?:sk|ghp|gho|xoxb|xoxp)[-_][a-z0-9_-]{16,}\b/gi, REDACTED)
    .replace(
      /((?:password|passwd|secret|token|api[-_]?key|session)["']?\s*[:=]\s*["']?)[^&\s,"'}]+/gi,
      `$1${REDACTED}`,
    );
}

function sanitizeStructured(
  value,
  key = '',
  depth = 0,
  budget = { remaining: OBJECT_ENTRY_LIMIT },
) {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeText(value, key);
  if (typeof value !== 'object') return truncate(value);
  if (depth >= OBJECT_DEPTH_LIMIT) return '[DEPTH_LIMIT]';
  if (budget.remaining <= 0) return '[TRUNCATED]';

  const result = Array.isArray(value) ? [] : {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (budget.remaining <= 0) {
      if (!Array.isArray(result)) result.__voidrTruncated = true;
      break;
    }
    budget.remaining -= 1;
    const safeKey = truncate(childKey, 128);
    result[safeKey] = sanitizeStructured(childValue, safeKey, depth + 1, budget);
  }
  return result;
}

export function sanitizeLiveUrl(value) {
  if (!value) return '';
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : null;
    const url = base ? new URL(String(value), base) : new URL(String(value));
    url.username = '';
    url.password = '';
    for (const [key, queryValue] of [...url.searchParams.entries()]) {
      url.searchParams.set(key, SENSITIVE_KEY.test(key) ? REDACTED : truncate(queryValue, 256));
    }
    return truncate(url.toString());
  } catch {
    return sanitizeText(value);
  }
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const result = {};
  let remaining = HEADER_TOTAL_LIMIT;
  for (const [key, value] of Object.entries(headers).slice(0, HEADER_LIMIT)) {
    if (remaining <= 0) break;
    const safeKey = truncate(key, 128);
    const safeValue = SENSITIVE_KEY.test(safeKey)
      ? REDACTED
      : truncate(sanitizeText(value, safeKey), Math.min(HEADER_VALUE_LIMIT, remaining));
    result[safeKey] = safeValue;
    remaining -= safeKey.length + safeValue.length;
  }
  return Object.keys(result).length ? result : null;
}

function boundPreview(value) {
  if (value == null || typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > STRING_LIMIT ? `${serialized.slice(0, STRING_LIMIT)}…` : value;
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

function sanitizeBodyPreview(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return boundPreview(sanitizeStructured(value));
  const text = String(value);
  try {
    return boundPreview(sanitizeStructured(JSON.parse(text)));
  } catch {
    try {
      if (text.includes('=') && !text.trimStart().startsWith('<')) {
        const params = new URLSearchParams(text);
        const result = {};
        for (const [key, paramValue] of [...params.entries()].slice(0, OBJECT_ENTRY_LIMIT)) {
          result[truncate(key, 128)] = SENSITIVE_KEY.test(key)
            ? REDACTED
            : sanitizeText(paramValue, key);
        }
        if (Object.keys(result).length) return boundPreview(result);
      }
    } catch {
      /* fall through to bounded text */
    }
    return sanitizeText(text);
  }
}

function normalizeRequest(payload) {
  const status = Number(payload.status);
  return {
    requestId: truncate(payload.requestId || '', 160),
    transport: truncate(payload.type || 'request', 40),
    method: truncate(payload.method || 'GET', 16).toUpperCase(),
    url: sanitizeLiveUrl(payload.url),
    status: Number.isFinite(status) ? status : null,
    statusText: sanitizeText(payload.statusText || '', 'statusText'),
    durationMs: Number.isFinite(Number(payload.duration))
      ? Math.max(0, Number(payload.duration))
      : null,
    error: sanitizeText(payload.error || '', 'error'),
    thirdParty: Boolean(payload.thirdParty),
    contentType: truncate(payload.contentType || '', 160),
    requestSize: Number.isFinite(Number(payload.requestSize))
      ? Math.max(0, Number(payload.requestSize))
      : null,
    responseSize: Number.isFinite(Number(payload.responseSize))
      ? Math.max(0, Number(payload.responseSize))
      : null,
    requestHeaders: sanitizeHeaders(payload.requestHeaders),
    responseHeaders: sanitizeHeaders(payload.responseHeaders),
    requestBodyPreview: sanitizeBodyPreview(payload.requestBody),
    responseBodyPreview: sanitizeBodyPreview(payload.responseBody ?? payload.response),
    timing: sanitizeStructured(payload.timing),
    traceId: sanitizeText(payload.traceId || '', 'trace'),
    graphql: boundPreview(sanitizeStructured(payload.graphql)),
  };
}

function normalizePage(payload) {
  return {
    url: sanitizeLiveUrl(payload.url),
    title: sanitizeText(payload.title || '', 'title'),
    from: sanitizeLiveUrl(payload.from),
    trigger: truncate(payload.trigger || 'unknown', 40),
  };
}

function normalizeClick(payload) {
  return {
    clickId: truncate(payload.clickId || '', 160),
    label: sanitizeText(payload.text || payload.label || '', 'label'),
    selector: sanitizeText(payload.selector || '', 'selector'),
    tag: truncate(payload.tag || '', 32),
    role: truncate(payload.role || '', 64),
    href: sanitizeLiveUrl(payload.href),
    position: sanitizeStructured(payload.position),
    effects: sanitizeStructured(payload.effects),
  };
}

function normalizeError(payload) {
  return {
    plugin: truncate(payload.plugin || payload.type || 'error', 80),
    name: truncate(payload.name || '', 120),
    message: sanitizeText(payload.message || payload.reason || payload.error || 'Unknown error'),
    stack: sanitizeText(payload.stack || '', 'stack'),
    filename: sanitizeLiveUrl(payload.filename || payload.sourceFile),
    position: truncate(payload.position || '', 64),
    blockedUrl: sanitizeLiveUrl(payload.url || payload.blockedURI),
    directive: truncate(payload.effectiveDirective || payload.violatedDirective || '', 160),
    hash: truncate(payload.hash || '', 160),
    occurrence: Number.isFinite(Number(payload.occurrence))
      ? Math.max(1, Number(payload.occurrence))
      : 1,
  };
}

function normalizeNote(payload) {
  return {
    kind: truncate(payload.kind || 'screen', 40),
    note: sanitizeText(payload.note || payload.transcript || '', 'note'),
    pageUrl: sanitizeLiveUrl(payload.pageUrl || payload.url),
    selector: sanitizeText(payload.selector || '', 'selector'),
    rect: sanitizeStructured(payload.rect),
    assetRefs: sanitizeStructured(payload.assetRefs),
    state: truncate(payload.state || 'saved', 40),
    durationMs: Number.isFinite(Number(payload.durationMs))
      ? Math.max(0, Number(payload.durationMs))
      : null,
  };
}

function normalize(category, payload) {
  if (category === 'requests') return normalizeRequest(payload);
  if (category === 'pages') return normalizePage(payload);
  if (category === 'clicks') return normalizeClick(payload);
  if (category === 'errors') return normalizeError(payload);
  return normalizeNote(payload);
}

function ensureState() {
  if (state.liveContext?.categories) return state.liveContext;
  state.liveContext = {
    sequence: 0,
    counts: Object.fromEntries(LIVE_CONTEXT_CATEGORIES.map((category) => [category, 0])),
    categories: Object.fromEntries(LIVE_CONTEXT_CATEGORIES.map((category) => [category, []])),
  };
  return state.liveContext;
}

function latest(category) {
  const items = ensureState().categories[category];
  return items[items.length - 1] || null;
}

export function recordLiveContext(category, payload = {}, options = {}) {
  if (!LIVE_CONTEXT_CATEGORIES.includes(category)) return null;
  const live = ensureState();
  const timestamp = Number.isFinite(Number(options.timestamp ?? payload.timestamp))
    ? Number(options.timestamp ?? payload.timestamp)
    : Date.now();
  if (category === 'pages') {
    const previousPage = latest('pages');
    if (previousPage && previousPage.durationMs == null) {
      previousPage.durationMs = Math.max(0, timestamp - previousPage.timestamp);
    }
  }
  live.sequence += 1;
  const page = category === 'pages' ? null : latest('pages');
  const click = category === 'clicks' ? null : latest('clicks');
  const stableId =
    options.id || payload.requestId || payload.clickId || `${category}-${live.sequence}`;
  const item = {
    id: truncate(stableId, 180),
    sequence: live.sequence,
    timestamp,
    offsetMs: Math.max(0, timestamp - (state.sessionStartedAt || timestamp)),
    pageRef: page?.id || null,
    clickRef: click && timestamp - click.timestamp <= CAUSAL_WINDOW_MS ? click.id : null,
    ...normalize(category, payload),
  };
  live.counts[category] += 1;
  const items = live.categories[category];
  items.push(item);
  if (items.length > RING_LIMIT) items.splice(0, items.length - RING_LIMIT);
  return item;
}

export function updateLiveContext(category, id, patch = {}) {
  if (!LIVE_CONTEXT_CATEGORIES.includes(category) || !id) return null;
  const item = [...ensureState().categories[category]].reverse().find((entry) => entry.id === id);
  if (!item) return null;
  const normalized = normalize(category, { ...item, ...patch });
  Object.assign(item, normalized);
  return item;
}

export function snapshotLiveContext(options = {}) {
  const live = ensureState();
  const category = LIVE_CONTEXT_CATEGORIES.includes(options.category) ? options.category : null;
  const limit = Math.min(READ_LIMIT, Math.max(1, Math.floor(Number(options.limit) || 20)));
  const selected = category ? [category] : LIVE_CONTEXT_CATEGORIES;
  const categories = {};
  for (const key of selected) {
    categories[key] = live.categories[key]
      .slice(-limit)
      .reverse()
      .map((item) => {
        try {
          return typeof structuredClone === 'function'
            ? structuredClone(item)
            : JSON.parse(JSON.stringify(item));
        } catch {
          return { ...item };
        }
      });
  }
  return {
    version: LIVE_CONTEXT_VERSION,
    generatedAt: Date.now(),
    startedAt: state.sessionStartedAt || null,
    sessionId: state.sessionId || null,
    counts: { ...live.counts },
    categories,
    limits: { ring: RING_LIMIT, read: READ_LIMIT, previewChars: STRING_LIMIT },
  };
}
