import { state } from '../state.js';
import {
  byteLength,
  extractFetchHeaders,
  extractGraphQL,
  extractPerformanceTiming,
  extractRequestBody,
  extractRequestHeaders,
  extractTraceId,
  getContentType,
  isThirdParty,
  processResponseBody,
  sanitizeHeaders,
} from './extractors.js';
import { logNetworkEvent, nextRequestId } from '../transport.js';
import { markNetworkActivity } from '../listeners/click-effect.js';

function normalizeUrl(input) {
  let url = typeof input === 'string' ? input : input?.url;
  if (!url || url.startsWith('http')) return url;
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return `${window.location.origin}${url}`;
  }
}

function isCollectorRequest(url) {
  const collectorUrl =
    typeof state.config.collectorUrl === 'string'
      ? state.config.collectorUrl.replace(/\/+$/, '')
      : '';
  return Boolean(url && collectorUrl && url.startsWith(collectorUrl));
}

function getMethod(input, init) {
  return (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function addOptionalMetadata(event, requestHeaders, requestBody) {
  if (state.config.captureTraceId) {
    const traceId = extractTraceId(requestHeaders);
    if (traceId) event.traceId = traceId;
  }
  const graphql = extractGraphQL(event.url, event.method, requestBody);
  if (graphql) event.graphql = graphql;
  return event;
}

function captureRequestBody(input, init, method) {
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return Promise.resolve(null);
  if (!(input instanceof Request) || init?.body) {
    return Promise.resolve().then(() => extractRequestBody(input, init));
  }
  try {
    const request = input.clone();
    return Promise.resolve().then(() => extractRequestBody(request, init, true));
  } catch {
    return Promise.resolve(null);
  }
}

function buildResponseEvent(context, response, responseBody) {
  const responseHeaders = sanitizeHeaders(extractFetchHeaders(response.headers));
  const event = {
    type: 'fetch',
    requestId: context.requestId,
    timestamp: context.startedAt,
    url: context.url,
    method: context.method,
    status: response.status,
    statusText: response.statusText,
    duration: Date.now() - context.startedAt,
    thirdParty: isThirdParty(context.url),
    origin: window.location.origin,
    requestHeaders: context.requestHeaders,
    responseHeaders,
    requestBody: context.requestBody,
    responseBody,
    timing: extractPerformanceTiming(context.url),
    contentType: getContentType(responseHeaders),
    responseSize: responseBody ? responseBody.length : 0,
    requestSize: byteLength(context.requestBody),
  };
  return addOptionalMetadata(event, context.requestHeaders, context.requestBody);
}

const isCurrentCapture = (context) =>
  !state.forceStop &&
  !state.isPaused &&
  !state.sessionRotationInFlight &&
  state.lifecycleId === context.lifecycleId &&
  state.sessionId === context.sessionId;

async function captureResponse(context, response) {
  try {
    if (!isCurrentCapture(context)) return;
    const cloned = response.clone();
    const [requestBody, responseBody] = await Promise.all([
      context.requestBodyPromise,
      processResponseBody(response, cloned),
    ]);
    if (!isCurrentCapture(context)) return;
    setTimeout(() => {
      if (!isCurrentCapture(context)) return;
      logNetworkEvent(buildResponseEvent({ ...context, requestBody }, response, responseBody));
    }, 50);
  } catch {}
}

async function captureError(context, error) {
  const requestBody = await context.requestBodyPromise;
  if (!isCurrentCapture(context)) return;
  logNetworkEvent({
    type: 'fetchError',
    requestId: context.requestId,
    timestamp: context.startedAt,
    url: context.url,
    method: context.method,
    error: error.message,
    thirdParty: isThirdParty(context.url),
    origin: window.location.origin,
    requestHeaders: context.requestHeaders,
    requestBody,
  });
}

export function initFetchInterceptor() {
  if (!state.config.networkCapture) return;
  const originalFetch = window.fetch;
  let active = true;
  state.originalFetch = originalFetch;

  const interceptedFetch = async function (...args) {
    const callOriginal = () => originalFetch.apply(window, args);
    if (
      !active ||
      state.forceStop ||
      !state.isInitialized ||
      state.isPaused ||
      state.sessionRotationInFlight
    ) {
      return callOriginal();
    }
    const [input, init] = args;
    const url = normalizeUrl(input);
    if (!url || isCollectorRequest(url)) return callOriginal();

    const method = getMethod(input, init);
    const context = {
      url,
      method,
      requestId: nextRequestId(),
      startedAt: Date.now(),
      lifecycleId: state.lifecycleId,
      sessionId: state.sessionId,
      requestHeaders: extractRequestHeaders(input, init),
      requestBodyPromise: captureRequestBody(input, init, method),
    };
    markNetworkActivity();

    try {
      const response = await callOriginal();
      void captureResponse(context, response);
      return response;
    } catch (error) {
      void captureError(context, error);
      throw error;
    }
  };
  state.interceptedFetch = interceptedFetch;
  state.deactivateFetchInterceptor = () => {
    active = false;
  };
  window.fetch = interceptedFetch;
}
