import { state } from '../state.js';
import {
  extractRequestHeaders,
  extractRequestBody,
  extractPerformanceTiming,
  processResponseBody,
  sanitizeHeaders,
  extractFetchHeaders,
  isThirdParty,
  getContentType,
  byteLength,
  extractTraceId,
} from './extractors.js';
import { logNetworkEvent, nextRequestId } from '../transport.js';
import { markNetworkActivity } from '../listeners/click-effect.js';
import { extractGraphQL } from './extractors.js';

/**
 * Intercept the global fetch() to capture network requests.
 * Saves the original fetch to state.originalFetch for restoration.
 */
export function initFetchInterceptor() {
  if (!state.config.networkCapture) return;

  state.originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const [input, init] = args;
    let requestUrl = typeof input === 'string' ? input : input.url;
    if (!requestUrl) {
      return state.originalFetch(...args);
    }

    if (!requestUrl.startsWith('http')) {
      try {
        requestUrl = new URL(requestUrl, window.location.origin).toString();
      } catch (_) {
        requestUrl = `${window.location.origin}${requestUrl}`;
      }
    }

    // Normalize collector base URL from config
    const normalizedCollectorBase =
      state.config && typeof state.config.collectorUrl === 'string'
        ? state.config.collectorUrl.replace(/\/+$/, '')
        : '';
    const isCollectorRequest = (() => {
      try {
        return (
          requestUrl && normalizedCollectorBase && requestUrl.startsWith(normalizedCollectorBase)
        );
      } catch (_) {
        return Boolean(
          requestUrl && normalizedCollectorBase && requestUrl.includes(normalizedCollectorBase),
        );
      }
    })();

    // Skip intercepting collector's own requests
    if (isCollectorRequest) {
      return state.originalFetch(...args);
    }

    const start = Date.now();
    const requestId = nextRequestId();
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    markNetworkActivity();

    // Capture request headers and body BEFORE making the request
    const requestHeaders = extractRequestHeaders(input, init);
    let requestBody = null;
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      requestBody = await extractRequestBody(input, init);
    }

    try {
      const response = await state.originalFetch(...args);
      const cloned = response.clone();

      // Process response asynchronously
      processResponseBody(response, cloned).then((responseBody) => {
        // Extract response headers
        const responseHeaders = sanitizeHeaders(extractFetchHeaders(response.headers));

        // Delay slightly so the Performance API entry is available
        setTimeout(() => {
          const timing = extractPerformanceTiming(requestUrl);

          const event = {
            type: 'fetch',
            requestId,
            timestamp: start,
            url: requestUrl,
            method: method.toUpperCase(),
            status: response.status,
            statusText: response.statusText,
            duration: Date.now() - start,
            thirdParty: isThirdParty(requestUrl),
            origin: window.location.origin,
            requestHeaders,
            responseHeaders,
            requestBody,
            responseBody,
            timing,
            contentType: getContentType(responseHeaders),
            responseSize: responseBody ? responseBody.length : 0,
            requestSize: byteLength(requestBody),
          };

          if (state.config.captureTraceId) {
            const traceId = extractTraceId(requestHeaders);
            if (traceId) event.traceId = traceId;
          }

          const gql = extractGraphQL(requestUrl, method, requestBody);
          if (gql) event.graphql = gql;

          logNetworkEvent(event);
        }, 50);
      });

      return response;
    } catch (error) {
      logNetworkEvent({
        type: 'fetchError',
        requestId,
        timestamp: start,
        url: requestUrl,
        method: method.toUpperCase(),
        error: error.message,
        thirdParty: isThirdParty(requestUrl),
        origin: window.location.origin,
        requestHeaders,
        requestBody,
      });
      throw error;
    }
  };
}
