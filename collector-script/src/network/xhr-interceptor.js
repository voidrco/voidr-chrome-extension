import { state } from '../state.js';
import { MAX_BODY_SIZE } from '../constants.js';
import {
  byteLength,
  extractGraphQL,
  extractPerformanceTiming,
  extractTraceId,
  getContentType,
  isCapturableContentType,
  isThirdParty,
  sanitizeHeaders,
} from './extractors.js';
import { logNetworkEvent, nextRequestId } from '../transport.js';
import { markNetworkActivity } from '../listeners/click-effect.js';

const RESPONSE_CAPTURE_DELAY_MS = 50;
const STRUCTURED_BODY_ENTRY_LIMIT = 200;
const STRUCTURED_BODY_DEPTH_LIMIT = 4;
const STRUCTURED_BODY_KEY_LIMIT = 256;
const STRUCTURED_BODY_VALUE_LIMIT = 2000;
const FORM_VALUE_LIMIT = 1000;
const RESPONSE_HEADER_COUNT_LIMIT = 100;
const RESPONSE_HEADERS_SIZE_LIMIT = 64 * 1024;

const truncate = (value, limit, marker = '...[TRUNCATED]') =>
  value.length > limit ? `${value.slice(0, limit)}${marker}` : value;

function normalizeUrl(url) {
  if (!url) return url;
  const normalized = String(url);
  if (normalized.startsWith('http')) return normalized;
  try {
    return new URL(normalized, window.location.origin).toString();
  } catch {
    return `${window.location.origin}${normalized}`;
  }
}

function isCollectorRequest(url) {
  const collectorUrl =
    typeof state.config.collectorUrl === 'string'
      ? state.config.collectorUrl.replace(/\/+$/, '')
      : '';
  return Boolean(url && collectorUrl && url.startsWith(collectorUrl));
}

function serializeFormValue(value) {
  if (typeof File !== 'undefined' && value instanceof File) {
    return `[File: ${value.name}, ${value.size} bytes, ${value.type}]`;
  }
  return typeof value === 'string' ? truncate(value, FORM_VALUE_LIMIT, '...') : String(value);
}

function serializeFormData(body) {
  const captured = Object.create(null);
  const iterator = body.entries();
  let count = 0;
  let step = iterator.next();

  while (!step.done && count < STRUCTURED_BODY_ENTRY_LIMIT) {
    const [key, value] = step.value;
    captured[truncate(String(key), STRUCTURED_BODY_KEY_LIMIT)] = serializeFormValue(value);
    count += 1;
    if (count < STRUCTURED_BODY_ENTRY_LIMIT) step = iterator.next();
  }

  if (count === STRUCTURED_BODY_ENTRY_LIMIT) captured.__voidrTruncated = true;
  return truncate(JSON.stringify(captured), MAX_BODY_SIZE);
}

function serializeUrlSearchParams(body) {
  const captured = new URLSearchParams();
  const iterator = body.entries();
  let count = 0;
  let step = iterator.next();

  while (!step.done && count < STRUCTURED_BODY_ENTRY_LIMIT) {
    const [key, value] = step.value;
    captured.append(
      truncate(String(key), STRUCTURED_BODY_KEY_LIMIT, ''),
      truncate(String(value), STRUCTURED_BODY_VALUE_LIMIT, ''),
    );
    count += 1;
    if (count < STRUCTURED_BODY_ENTRY_LIMIT) step = iterator.next();
  }

  const serialized = captured.toString();
  return count === STRUCTURED_BODY_ENTRY_LIMIT
    ? `${serialized}${serialized ? '&' : ''}...[TRUNCATED]`
    : serialized;
}

function readOwnValue(owner, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor) return null;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return '[Accessor]';
    return descriptor.value;
  } catch {
    return '[Unreadable]';
  }
}

function snapshotArray(value, budget, seen, depth) {
  const snapshot = [];
  let index = 0;

  while (index < value.length && budget.remaining > 0) {
    budget.remaining -= 1;
    snapshot.push(
      snapshotStructuredValue(readOwnValue(value, String(index)), budget, seen, depth + 1),
    );
    index += 1;
  }

  if (value.length > index) snapshot.push('[TRUNCATED]');
  return snapshot;
}

function snapshotObject(value, budget, seen, depth) {
  const snapshot = Object.create(null);
  let truncated = false;

  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    budget.remaining -= 1;
    snapshot[truncate(key, STRUCTURED_BODY_KEY_LIMIT, '')] = snapshotStructuredValue(
      readOwnValue(value, key),
      budget,
      seen,
      depth + 1,
    );
  }

  if (truncated) snapshot.__voidrTruncated = true;
  return snapshot;
}

function snapshotStructuredValue(value, budget, seen, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return truncate(value, STRUCTURED_BODY_VALUE_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return '[Function]';
  if (depth >= STRUCTURED_BODY_DEPTH_LIMIT) return '[DepthLimit]';
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Date) return Date.prototype.toISOString.call(value);
  if (value instanceof RegExp) return RegExp.prototype.toString.call(value);

  seen.add(value);
  return Array.isArray(value)
    ? snapshotArray(value, budget, seen, depth)
    : snapshotObject(value, budget, seen, depth);
}

function serializeStructuredBody(body) {
  try {
    const snapshot = snapshotStructuredValue(
      body,
      { remaining: STRUCTURED_BODY_ENTRY_LIMIT },
      new WeakSet(),
      0,
    );
    return truncate(JSON.stringify(snapshot), MAX_BODY_SIZE);
  } catch {
    return '[Unserializable Body]';
  }
}

function serializeRequestBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return truncate(body, MAX_BODY_SIZE);
  if (typeof FormData !== 'undefined' && body instanceof FormData) return serializeFormData(body);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return serializeUrlSearchParams(body);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return `[Blob: ${body.size} bytes, ${body.type}]`;
  }
  if (body instanceof ArrayBuffer) return `[ArrayBuffer: ${body.byteLength} bytes]`;
  if (ArrayBuffer.isView(body)) {
    return `[${body.constructor?.name || 'ArrayBufferView'}: ${body.byteLength} bytes]`;
  }
  return serializeStructuredBody(body);
}

function readResponseHeaders(xhr) {
  try {
    const raw = truncate(
      String(xhr.getAllResponseHeaders() || ''),
      RESPONSE_HEADERS_SIZE_LIMIT,
      '',
    );
    return raw
      .split('\r\n')
      .slice(0, RESPONSE_HEADER_COUNT_LIMIT)
      .reduce((headers, line) => {
        const separator = line.indexOf(':');
        if (separator <= 0) return headers;
        headers[line.slice(0, separator)] = line.slice(separator + 1).trim();
        return headers;
      }, {});
  } catch {
    return {};
  }
}

function readContentType(xhr, responseHeaders) {
  try {
    return xhr.getResponseHeader('content-type') || getContentType(responseHeaders);
  } catch {
    return getContentType(responseHeaders);
  }
}

function readResponseBody(xhr, contentType) {
  if (!isCapturableContentType(contentType)) {
    return `[${contentType || 'unknown'} - not captured]`;
  }
  try {
    return truncate(xhr.responseText || '', MAX_BODY_SIZE);
  } catch {
    return '[Response body unavailable]';
  }
}

const isCurrentCapture = (context) =>
  context.isActive() &&
  context.isSameRequest() &&
  !state.forceStop &&
  !state.isPaused &&
  !state.sessionRotationInFlight &&
  state.lifecycleId === context.lifecycleId &&
  state.sessionId === context.sessionId;

function addOptionalMetadata(event, requestHeaders, requestBody) {
  if (state.config.captureTraceId) {
    const traceId = extractTraceId(requestHeaders);
    if (traceId) event.traceId = traceId;
  }
  const graphql = extractGraphQL(event.url, event.method, requestBody);
  if (graphql) event.graphql = graphql;
  return event;
}

function buildResponseEvent(xhr, context, completedAt) {
  const requestBody = serializeRequestBody(context.body);
  const responseHeaders = readResponseHeaders(xhr);
  const contentType = readContentType(xhr, responseHeaders);
  const responseBody = readResponseBody(xhr, contentType);
  const requestHeaders = sanitizeHeaders(context.requestHeaders);
  const event = {
    type: 'xhr',
    requestId: context.requestId,
    timestamp: context.startedAt,
    url: context.url,
    method: context.method,
    status: xhr.status,
    statusText: xhr.statusText,
    duration: completedAt - context.startedAt,
    thirdParty: isThirdParty(context.url),
    origin: window.location.origin,
    requestHeaders,
    responseHeaders: sanitizeHeaders(responseHeaders),
    requestBody,
    responseBody,
    timing: extractPerformanceTiming(context.url),
    contentType: contentType ? contentType.split(';')[0].trim().toLowerCase() : '',
    responseSize: responseBody ? responseBody.length : 0,
    requestSize: byteLength(requestBody),
  };
  return addOptionalMetadata(event, requestHeaders, requestBody);
}

function scheduleResponseCapture(xhr, context, completedAt) {
  setTimeout(() => {
    if (!isCurrentCapture(context)) return;
    try {
      const event = buildResponseEvent(xhr, context, completedAt);
      if (isCurrentCapture(context)) logNetworkEvent(event);
    } catch {}
  }, RESPONSE_CAPTURE_DELAY_MS);
}

export function initXhrInterceptor() {
  if (!state.config.networkCapture) return;

  const OriginalXHR = window.XMLHttpRequest;
  let active = true;
  state.originalXHR = OriginalXHR;

  function InterceptedXHR() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    const originalSetRequestHeader = xhr.setRequestHeader;
    let method = '';
    let url = '';
    let requestHeaders = {};
    let requestGeneration = 0;

    xhr.open = function (_method, _url) {
      method = _method;
      url = normalizeUrl(_url);
      requestHeaders = {};
      requestGeneration += 1;
      return originalOpen.apply(this, arguments);
    };

    xhr.setRequestHeader = function (header, value) {
      requestHeaders[header] = value;
      return originalSetRequestHeader.apply(this, arguments);
    };

    xhr.send = function (body) {
      if (
        !active ||
        state.forceStop ||
        !state.isInitialized ||
        state.isPaused ||
        state.sessionRotationInFlight ||
        isCollectorRequest(url)
      ) {
        return originalSend.apply(this, arguments);
      }

      const generation = requestGeneration;
      const context = {
        body,
        url,
        method: method.toUpperCase(),
        requestId: nextRequestId(),
        startedAt: Date.now(),
        lifecycleId: state.lifecycleId,
        sessionId: state.sessionId,
        requestHeaders: { ...requestHeaders },
        isActive: () => active,
        isSameRequest: () => requestGeneration === generation,
      };
      const onLoadEnd = () => scheduleResponseCapture(this, context, Date.now());
      this.addEventListener('loadend', onLoadEnd, { once: true });

      let result;
      try {
        result = originalSend.apply(this, arguments);
      } catch (error) {
        this.removeEventListener?.('loadend', onLoadEnd);
        throw error;
      }
      markNetworkActivity();
      return result;
    };

    return xhr;
  }

  Object.setPrototypeOf(InterceptedXHR, OriginalXHR);
  InterceptedXHR.prototype = OriginalXHR.prototype;
  state.interceptedXHR = InterceptedXHR;
  state.deactivateXhrInterceptor = () => {
    active = false;
  };
  window.XMLHttpRequest = InterceptedXHR;
}
