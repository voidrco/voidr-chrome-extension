import {
  SENSITIVE_HEADERS,
  CAPTURABLE_CONTENT_TYPES,
  IGNORED_CONTENT_TYPES,
  MAX_BODY_SIZE,
  TRACE_ID_HEADERS,
  RESOURCE_EXT_CONTENT_TYPES,
} from '../constants.js';

/**
 * Check if a URL's hostname differs from the current page origin.
 */
export function isThirdParty(url) {
  try {
    const currentHost = window.location.hostname;
    const targetHost = new URL(url).hostname;
    return !targetHost.endsWith(currentHost);
  } catch (e) {
    return false;
  }
}

/**
 * Check if a content-type is capturable (API data, not files/binaries).
 */
export function isCapturableContentType(contentType) {
  if (!contentType) return false;
  const lowerType = contentType.toLowerCase();
  const isIgnored = IGNORED_CONTENT_TYPES.some((ignored) => lowerType.includes(ignored));
  if (isIgnored) return false;
  return CAPTURABLE_CONTENT_TYPES.some((allowed) => lowerType.includes(allowed));
}

/**
 * Redact sensitive headers for privacy.
 */
export function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const sanitized = {};
  Object.entries(headers).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_HEADERS.some(
      (sensitive) => lowerKey.includes(sensitive) || lowerKey === sensitive,
    );
    sanitized[key] = isSensitive ? '[REDACTED]' : value;
  });
  return sanitized;
}

/**
 * Extract headers from a Fetch API Headers object to a plain object.
 */
export function extractFetchHeaders(headers) {
  if (!headers) return {};
  const result = {};
  try {
    if (typeof headers.entries === 'function') {
      for (const [key, value] of headers.entries()) {
        result[key] = value;
      }
    } else if (typeof headers.forEach === 'function') {
      headers.forEach((value, key) => {
        result[key] = value;
      });
    } else if (typeof headers === 'object') {
      Object.assign(result, headers);
    }
  } catch (e) {
    // Headers may not be accessible (CORS)
  }
  return result;
}

/**
 * Extract headers from a RequestInit or Request object.
 */
export function extractRequestHeaders(input, init) {
  const headers = {};
  try {
    // If input is a Request object
    if (input instanceof Request) {
      const reqHeaders = extractFetchHeaders(input.headers);
      Object.assign(headers, reqHeaders);
    }
    // Init headers override
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        Object.assign(headers, extractFetchHeaders(init.headers));
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([key, value]) => {
          headers[key] = value;
        });
      } else if (typeof init.headers === 'object') {
        Object.assign(headers, init.headers);
      }
    }
  } catch (e) {
    // Ignore extraction errors
  }
  return sanitizeHeaders(headers);
}

/**
 * Extract the request body (for POST, PUT, PATCH methods).
 * Handles string, FormData, URLSearchParams, Blob, ArrayBuffer.
 */
export async function extractRequestBody(input, init) {
  try {
    let body = init?.body;
    // If input is Request and no body in init
    if (!body && input instanceof Request) {
      try {
        body = await input.clone().text();
      } catch (e) {
        return null;
      }
    }
    if (!body) return null;
    // String
    if (typeof body === 'string') {
      return body.length > MAX_BODY_SIZE
        ? body.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
        : body;
    }
    // FormData
    if (body instanceof FormData) {
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
      return JSON.stringify(formDataObj);
    }
    // URLSearchParams
    if (body instanceof URLSearchParams) {
      return body.toString();
    }
    // Blob
    if (body instanceof Blob) {
      if (body.size > MAX_BODY_SIZE) {
        return `[Blob: ${body.size} bytes, ${body.type}]`;
      }
      try {
        const text = await body.text();
        return text;
      } catch (e) {
        return `[Blob: ${body.size} bytes]`;
      }
    }
    // ArrayBuffer
    if (body instanceof ArrayBuffer) {
      return `[ArrayBuffer: ${body.byteLength} bytes]`;
    }
    // Other (try to stringify)
    try {
      const str = JSON.stringify(body);
      return str.length > MAX_BODY_SIZE ? str.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]' : str;
    } catch (e) {
      return '[Unserializable Body]';
    }
  } catch (e) {
    return null;
  }
}

/**
 * Normalize a content-type header value to a bare MIME (drops charset/params).
 * Returns '' when no content-type can be determined.
 */
export function getContentType(headers) {
  if (!headers || typeof headers !== 'object') return '';
  let value = '';
  for (const [key, val] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'content-type') {
      value = val == null ? '' : String(val);
      break;
    }
  }
  return (value.split(';')[0] || '').trim().toLowerCase();
}

/**
 * Best-effort byte length of a (possibly Unicode) string. Used to populate
 * `requestSize` from a captured request body. Returns 0 for empty/non-strings.
 */
export function byteLength(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  try {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(value).length;
    }
    if (typeof Blob !== 'undefined') {
      return new Blob([value]).size;
    }
  } catch (e) {
    // Fall through to length-based estimate.
  }
  return value.length;
}

/**
 * Best-effort traceId/correlation id from request headers. Only returns a value
 * when one of the known correlation headers is present (never invents an id).
 */
export function extractTraceId(headers) {
  if (!headers || typeof headers !== 'object') return null;
  for (const [key, val] of Object.entries(headers)) {
    if (val == null || val === '') continue;
    if (TRACE_ID_HEADERS.includes(String(key).toLowerCase())) {
      return String(val);
    }
  }
  return null;
}

/**
 * Best-effort content-type for a static resource derived from its URL extension.
 * PerformanceResourceTiming exposes no headers, so this is the only signal we
 * have when the entry doesn't carry an explicit content-type.
 */
export function guessContentTypeFromUrl(url) {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    const match = pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    if (match && RESOURCE_EXT_CONTENT_TYPES[match[1]]) {
      return RESOURCE_EXT_CONTENT_TYPES[match[1]];
    }
  } catch (e) {
    // Ignore malformed URLs.
  }
  return '';
}

/**
 * Map a PerformanceResourceTiming entry to the collector timing breakdown
 * (values in ms). receive ⇐ download on the decoder side.
 */
export function timingFromResourceEntry(entry) {
  if (!entry) return null;
  const dns = Math.round(entry.domainLookupEnd - entry.domainLookupStart);
  const connect = Math.round(entry.connectEnd - entry.connectStart);
  const ssl =
    entry.secureConnectionStart > 0
      ? Math.round(entry.connectEnd - entry.secureConnectionStart)
      : 0;
  const wait = Math.round(entry.responseStart - entry.requestStart); // TTFB
  const download = Math.round(entry.responseEnd - entry.responseStart);
  const total = Math.round(entry.responseEnd - entry.startTime);
  return {
    dns: Math.max(0, dns),
    connect: Math.max(0, connect),
    ssl: Math.max(0, ssl),
    wait: Math.max(0, wait),
    download: Math.max(0, download),
    total: Math.max(0, total),
  };
}

/**
 * Extract performance timing data (DNS, SSL, TTFB, etc.) from the Performance API.
 */
export function extractPerformanceTiming(url) {
  try {
    if (!window.performance || !window.performance.getEntriesByName) return null;
    const entries = window.performance.getEntriesByName(url, 'resource');
    if (!entries || entries.length === 0) return null;
    const entry = entries[entries.length - 1]; // Most recent entry
    if (!entry) return null;
    // Calculate breakdown (values in ms)
    const dns = Math.round(entry.domainLookupEnd - entry.domainLookupStart);
    const connect = Math.round(entry.connectEnd - entry.connectStart);
    const ssl =
      entry.secureConnectionStart > 0
        ? Math.round(entry.connectEnd - entry.secureConnectionStart)
        : 0;
    const wait = Math.round(entry.responseStart - entry.requestStart); // TTFB
    const download = Math.round(entry.responseEnd - entry.responseStart);
    return {
      dns: Math.max(0, dns),
      connect: Math.max(0, connect),
      ssl: Math.max(0, ssl),
      wait: Math.max(0, wait),
      download: Math.max(0, download),
      total: Math.round(entry.duration),
    };
  } catch (e) {
    return null;
  }
}

/**
 * Process the response body based on content-type.
 * Only captures data types (JSON, XML, etc.), not files/HTML.
 */
export async function processResponseBody(response, clonedResponse) {
  try {
    const contentType = response.headers.get('content-type') || '';
    // Check if we should capture this content type
    if (!isCapturableContentType(contentType)) {
      return `[${contentType || 'unknown'} - not captured]`;
    }
    // Check size via Content-Length if available
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
      return `[Response too large: ${contentLength} bytes]`;
    }
    const text = await clonedResponse.text();
    if (text.length > MAX_BODY_SIZE) {
      return text.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]';
    }
    return text;
  } catch (e) {
    return '[Failed to read response]';
  }
}
