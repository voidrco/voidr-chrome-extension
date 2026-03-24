import { state } from '../state.js';
import { MAX_BODY_SIZE } from '../constants.js';
import {
  sanitizeHeaders,
  isCapturableContentType,
  extractPerformanceTiming,
  isThirdParty,
} from './extractors.js';
import { logNetworkEvent } from '../transport.js';

/**
 * Intercept XMLHttpRequest to capture network requests.
 * Saves the original XMLHttpRequest to state.originalXHR for restoration.
 */
export function initXhrInterceptor() {
  if (!state.config.networkCapture) return;

  state.originalXHR = window.XMLHttpRequest;

  function InterceptedXHR() {
    const xhr = new state.originalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    const originalSetRequestHeader = xhr.setRequestHeader;

    let method = '';
    let url = '';
    let requestHeaders = {};
    let requestBody = null;

    xhr.open = function (_method, _url) {
      method = _method;
      url = _url;
      // Normalize URL
      if (url && !url.startsWith('http')) {
        try {
          url = new URL(url, window.location.origin).toString();
        } catch (_) {
          url = `${window.location.origin}${url}`;
        }
      }
      return originalOpen.apply(this, arguments);
    };

    xhr.setRequestHeader = function (header, value) {
      requestHeaders[header] = value;
      return originalSetRequestHeader.apply(this, arguments);
    };

    xhr.send = function (body) {
      const start = Date.now();

      // Capture request body
      if (body !== null && body !== undefined) {
        if (typeof body === 'string') {
          requestBody =
            body.length > MAX_BODY_SIZE
              ? body.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
              : body;
        } else if (body instanceof FormData) {
          const formDataObj = {};
          body.forEach((value, key) => {
            if (value instanceof File) {
              formDataObj[key] = `[File: ${value.name}, ${value.size} bytes, ${value.type}]`;
            } else {
              formDataObj[key] =
                typeof value === 'string' && value.length > 1000
                  ? value.substring(0, 1000) + '...'
                  : value;
            }
          });
          requestBody = JSON.stringify(formDataObj);
        } else if (body instanceof URLSearchParams) {
          requestBody = body.toString();
        } else if (body instanceof Blob) {
          requestBody = `[Blob: ${body.size} bytes, ${body.type}]`;
        } else if (body instanceof ArrayBuffer) {
          requestBody = `[ArrayBuffer: ${body.byteLength} bytes]`;
        } else {
          try {
            requestBody = JSON.stringify(body);
          } catch (e) {
            requestBody = '[Unserializable Body]';
          }
        }
      }

      const baseCollectorUrl =
        state.config && typeof state.config.collectorUrl === 'string'
          ? state.config.collectorUrl.replace(/\/+$/, '')
          : '';
      const isCollectorRequest = url && baseCollectorUrl && url.startsWith(baseCollectorUrl);

      if (isCollectorRequest) {
        return originalSend.apply(this, arguments);
      }

      this.addEventListener('loadend', () => {
        // Extract response headers
        const responseHeadersRaw = this.getAllResponseHeaders();
        const responseHeaders = {};
        if (responseHeadersRaw) {
          responseHeadersRaw.split('\r\n').forEach((line) => {
            const parts = line.split(': ');
            if (parts.length >= 2) {
              const key = parts.shift();
              const value = parts.join(': ');
              if (key) responseHeaders[key] = value;
            }
          });
        }

        // Process response body based on content-type
        const contentType = this.getResponseHeader('content-type') || '';
        let responseBody = null;
        if (isCapturableContentType(contentType)) {
          const responseText = this.responseText || '';
          responseBody =
            responseText.length > MAX_BODY_SIZE
              ? responseText.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
              : responseText;
        } else {
          responseBody = `[${contentType || 'unknown'} - not captured]`;
        }

        // Delay slightly so the Performance API entry is available
        setTimeout(() => {
          const timing = extractPerformanceTiming(url);

          logNetworkEvent({
            type: 'xhr',
            url: url,
            method: method.toUpperCase(),
            status: this.status,
            statusText: this.statusText,
            duration: Date.now() - start,
            thirdParty: isThirdParty(url),
            origin: window.location.origin,
            requestHeaders: sanitizeHeaders(requestHeaders),
            responseHeaders: sanitizeHeaders(responseHeaders),
            requestBody,
            responseBody,
            timing,
            responseSize: responseBody ? responseBody.length : 0,
          });
        }, 50);
      });

      return originalSend.apply(this, arguments);
    };

    return xhr;
  }

  window.XMLHttpRequest = InterceptedXHR;
}
