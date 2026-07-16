import { state } from '../state.js';
import { logNetworkEvent } from '../transport.js';
import { isThirdParty, timingFromResourceEntry, guessContentTypeFromUrl } from './extractors.js';

// initiatorTypes already captured by the fetch/XHR interceptors — skipped here
// so resources don't double-count API calls.
const SKIPPED_INITIATORS = new Set(['fetch', 'xmlhttprequest', 'beacon']);

/**
 * Build a `type: 'resource'` network event from a PerformanceResourceTiming
 * entry. URLs + timing only — NEVER bodies. Returns null when the entry should
 * be skipped (collector traffic, fetch/xhr duplicates, missing URL).
 */
function buildResourceEvent(entry) {
  const url = entry && entry.name;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;

  const initiatorType = (entry.initiatorType || '').toLowerCase();
  if (SKIPPED_INITIATORS.has(initiatorType)) return null;

  // Skip the collector's own traffic.
  const normalizedCollectorBase =
    state.config && typeof state.config.collectorUrl === 'string'
      ? state.config.collectorUrl.replace(/\/+$/, '')
      : '';
  if (normalizedCollectorBase && url.startsWith(normalizedCollectorBase)) return null;

  const responseSize = entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0;

  // responseStatus is only exposed by modern browsers; otherwise unknown (0).
  const status = typeof entry.responseStatus === 'number' ? entry.responseStatus : 0;

  // Reconstruct the wall-clock start of the resource load from the
  // high-resolution entry (timeOrigin + startTime).
  const timeOrigin =
    typeof performance !== 'undefined' && performance.timeOrigin
      ? performance.timeOrigin
      : Date.now();

  return {
    type: 'resource',
    timestamp: Math.round(timeOrigin + (entry.startTime || 0)),
    url,
    method: 'GET',
    status,
    duration: Math.round(entry.duration) || 0,
    thirdParty: isThirdParty(url),
    origin: window.location.origin,
    timing: timingFromResourceEntry(entry),
    contentType: guessContentTypeFromUrl(url),
    responseSize,
    requestSize: 0,
  };
}

/**
 * Process a list of PerformanceResourceTiming entries: apply per-entry sampling
 * and the per-session cap, then emit through the same network batch path.
 */
function handleEntries(entries) {
  if (state.forceStop || state.isPaused || !state.isInitialized) return;
  const sampleRate = state.config.captureResourcesSampleRate;
  const maxPerSession = state.config.captureResourcesMaxPerSession;

  for (const entry of entries) {
    if (state.resourceCount >= maxPerSession) {
      // Cap reached — stop observing to avoid any further overhead.
      if (state.resourceObserver) {
        try {
          state.resourceObserver.disconnect();
        } catch (e) {
          // Ignore.
        }
        state.resourceObserver = null;
      }
      return;
    }

    if (sampleRate < 1 && Math.random() > sampleRate) continue;

    const event = buildResourceEvent(entry);
    if (!event) continue;

    state.resourceCount += 1;
    logNetworkEvent(event);
  }
}

/**
 * Start capturing static resources (img/script/css/font/other) via
 * PerformanceObserver as network events with type: 'resource'.
 * Gated behind networkCapture + captureResources (default OFF).
 */
export function initResourceObserver() {
  if (!state.config.networkCapture || !state.config.captureResources) return;
  if (typeof PerformanceObserver === 'undefined') return;
  if (state.resourceObserver) return;

  state.resourceCount = 0;

  try {
    const observer = new PerformanceObserver((list) => {
      try {
        handleEntries(list.getEntries());
      } catch (e) {
        // Best-effort — never break the page.
      }
    });
    // `buffered: true` replays resource entries that loaded before we attached.
    observer.observe({ type: 'resource', buffered: true });
    state.resourceObserver = observer;
  } catch (e) {
    // Older browsers may not support the buffered flag / resource entry type.
    try {
      const observer = new PerformanceObserver((list) => {
        try {
          handleEntries(list.getEntries());
        } catch (_) {
          // Ignore.
        }
      });
      observer.observe({ entryTypes: ['resource'] });
      state.resourceObserver = observer;
    } catch (_) {
      // Resource capture unavailable — degrade silently.
    }
  }
}
