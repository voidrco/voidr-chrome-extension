import { gzip } from 'pako';
import { state } from './state.js';
import { safeStringify } from './utils/helpers.js';
import { compressEventsBase64 } from './utils/image-compression.js';
import { TOKEN_REFRESH_MARGIN_MS, decodeJwtExp } from './utils/jwt.js';

const SCREEN_MAP_SYNC_DEBOUNCE_MS = 2000;

// Unique per page-load so requestIds never collide across pages of the same
// session (multi-page sessions share a sessionId but reload this script).
const pageToken = Math.random().toString(36).slice(2, 8);
let requestSeq = 0;

/**
 * Monotonic, page-unique id for a captured network request. This is the
 * stable identity used end-to-end (decode → ClickHouse → REST → viewer
 * selection); batching assigns a single rrweb timestamp to many requests, so
 * url+offset alone is NOT unique.
 */
export function nextRequestId() {
  requestSeq += 1;
  return `${pageToken}-${requestSeq}`;
}

// setTimeout stores its delay in a signed 32-bit int
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// Floor between refresh attempts — keeps a near-expiry or clock-skewed token
// from turning the proactive refresh into a request loop
const MIN_TOKEN_REFRESH_DELAY_MS = 30 * 1000;

let refreshInFlight = null;
let expiryWatchInstalled = false;

/**
 * POST /refresh-token, persist the new JWT, and re-arm the proactive refresh
 * timer against the new expiry. Single-flight: concurrent callers (proactive
 * timer + reactive 401 paths) share one request.
 */
export function refreshAuthToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshResponse = await fetch(`${state.config.collectorUrl}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: safeStringify({ apiKey: state.config.apiKey }),
    });
    if (!refreshResponse.ok) {
      throw new Error('VoidrCollector: Failed to refresh token');
    }
    const data = await refreshResponse.json().catch(() => ({}));
    const token = data.token || null;
    if (!token) {
      throw new Error('VoidrCollector: Failed to refresh token');
    }
    state.authToken = token;
    try {
      sessionStorage.setItem('voidr_jwt', token);
    } catch (_) {
    }
    scheduleTokenRefresh();
    return token;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Schedule a proactive token refresh shortly before the current JWT expires.
 */
export function scheduleTokenRefresh() {
  if (state.tokenRefreshTimer) {
    clearTimeout(state.tokenRefreshTimer);
    state.tokenRefreshTimer = null;
  }
  if (state.forceStop || !state.authToken) return;

  const exp = decodeJwtExp(state.authToken);
  if (exp == null) return;

  installExpiryWatch();

  const delay = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TOKEN_REFRESH_DELAY_MS, exp * 1000 - Date.now() - TOKEN_REFRESH_MARGIN_MS),
  );

  state.tokenRefreshTimer = setTimeout(() => {
    state.tokenRefreshTimer = null;
    if (state.forceStop) return;
    console.debug('VoidrCollector: refreshing ingest token proactively');
    refreshAuthToken().catch(() => {
      // A failed refresh must not kill the proactive path: re-arm against the
      // stale exp, which clamps to MIN_TOKEN_REFRESH_DELAY_MS (retry in 30s).
      scheduleTokenRefresh();
    });
  }, delay);
}

// setTimeout doesn't tick through system sleep and background tabs get
// throttled — on wake the token can be past the margin (or expired) with the
// timer still pending. Re-check the expiry whenever the page becomes visible.
function installExpiryWatch() {
  if (expiryWatchInstalled || typeof document === 'undefined') return;
  expiryWatchInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.forceStop || !state.authToken) return;
    const exp = decodeJwtExp(state.authToken);
    if (exp != null && exp * 1000 - Date.now() <= TOKEN_REFRESH_MARGIN_MS) {
      refreshAuthToken().catch(() => {
      });
    }
  });
}

/**
 * Buffer a network event. Flushes automatically when buffer exceeds 10 entries.
 * Guarantees every request carries a unique `requestId` and an individual
 * wall-clock `timestamp` (batch flush time is NOT per-request time).
 */
export function logNetworkEvent(data) {
  if (!data.requestId) data.requestId = nextRequestId();
  if (!data.timestamp) data.timestamp = Date.now();
  state.networkBuffer.push(data);
  if (state.networkBuffer.length > 10) sendNetworkEvents();
}

/**
 * Flush the network buffer into the main events array as a batch event.
 */
export function sendNetworkEvents() {
  if (state.networkBuffer.length === 0) return;

  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin: 'network.batch',
      payload: {
        requests: state.networkBuffer.splice(0),
      },
    },
  });
}

/**
 * Compress and send a batch of events to the collector server.
 * Handles token refresh on 401 responses.
 */
export async function sendEvents() {
  const MIN_BATCH_SIZE = 10;
  if (state.isSending || state.events.length < MIN_BATCH_SIZE || state.forceStop || state.isPaused)
    return;
  state.isSending = true;

  const batch = state.events.splice(0, 100);
  const compressedBatch = await compressEventsBase64(batch);

  const startedAt = compressedBatch[0]?.timestamp ?? Date.now();
  const endedAt = compressedBatch[compressedBatch.length - 1]?.timestamp ?? Date.now();

  const payload = {
    userId: state.userId || null,
    sessionId: state.sessionId,
    userTraits: state.config.user,
    events: compressedBatch,
    maskedElements: state.config.dataMasking.blockSelectors,
    sessionTimeout: state.config.sessionTimeout,
    startedAt,
    endedAt,
    meta: state.config.meta,
    applicationId: state.config.applicationId,
    environment: state.config.environment,
  };

  try {
    const compressed = gzip(safeStringify(payload));

    let res = await fetch(`${state.config.collectorUrl}/sessions/chunk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
      },
      body: compressed,
    });

    // Fallback: token expired/revoked mid-send — refresh and retry once.
    if (res.status === 401) {
      const token = await refreshAuthToken();
      res = await fetch(`${state.config.collectorUrl}/sessions/chunk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          Authorization: `Bearer ${token}`,
        },
        body: compressed,
      });
    }

    if (!res.ok) {
      throw new Error('VoidrCollector: Failed to send events');
    }
  } catch (error) {
    console.error('VoidrCollector: Failed to send events', error);
    state.events.unshift(...batch);
  } finally {
    state.isSending = false;
  }
}

/**
 * Force-flush all buffered events immediately, bypassing MIN_BATCH_SIZE.
 * Returns a Promise that resolves when all events have been sent.
 * Does NOT stop recording — use this before stopping a session.
 */
export async function flushEvents() {
  // Flush network buffer into main events array first
  sendNetworkEvents();

  if (state.events.length === 0 || state.forceStop) return;

  // Wait for any in-flight send to complete before flushing
  while (state.isSending) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // Send all remaining events (may need multiple batches of 100)
  while (state.events.length > 0 && !state.forceStop) {
    state.isSending = true;
    const batch = state.events.splice(0, 100);
    const compressedBatch = await compressEventsBase64(batch);

    const startedAt = compressedBatch[0]?.timestamp ?? Date.now();
    const endedAt = compressedBatch[compressedBatch.length - 1]?.timestamp ?? Date.now();

    const payload = {
      userId: state.userId || null,
      sessionId: state.sessionId,
      userTraits: state.config.user,
      events: compressedBatch,
      maskedElements: state.config.dataMasking.blockSelectors,
      sessionTimeout: state.config.sessionTimeout,
      startedAt,
      endedAt,
      meta: state.config.meta,
      applicationId: state.config.applicationId,
      environment: state.config.environment,
    };

    try {
      const compressed = gzip(safeStringify(payload));
      const res = await fetch(`${state.config.collectorUrl}/sessions/chunk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
        },
        body: compressed,
      });

      if (!res.ok) {
        state.events.unshift(...batch);
        break;
      }
    } catch {
      state.events.unshift(...batch);
      break;
    } finally {
      state.isSending = false;
    }
  }
}

/**
 * Sync the screen map to the dedicated /screen-map/sync endpoint.
 * Only sends if the ElementMapper has new data since last sync (dirty flag).
 * Failures are non-fatal — recording continues normally.
 */
export async function syncScreenMap() {
  if (!state.elementMapper || state.forceStop) return;
  if (!state.elementMapper.isDirty()) return;
  if (state.screenMapSyncInFlight) {
    state.screenMapSyncQueued = true;
    return;
  }

  state.screenMapSyncInFlight = true;
  let runQueuedSync = false;

  try {
    const dirtyVersion =
      typeof state.elementMapper.getDirtyVersion === 'function'
        ? state.elementMapper.getDirtyVersion()
        : undefined;
    const snapshot = state.elementMapper.getSnapshot();
    if (!snapshot.screens.length) return;

    const payload = safeStringify({
      sessionId: state.sessionId,
      applicationId: state.config.applicationId,
      environment: state.config.environment,
      screens: snapshot.screens,
    });

    const compressed = gzip(payload);

    let res = await fetch(`${state.config.collectorUrl}/screen-map/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
      },
      body: compressed,
    });

    // Fallback: token expired/revoked mid-sync — refresh and retry once.
    if (res.status === 401) {
      try {
        const token = await refreshAuthToken();
        res = await fetch(`${state.config.collectorUrl}/screen-map/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            Authorization: `Bearer ${token}`,
          },
          body: compressed,
        });
      } catch {
        /* non-fatal — next sync retries */
      }
    }

    if (res.ok || res.status === 204) {
      state.elementMapper.clearDirty(dirtyVersion);
    }
  } catch {
    // Non-fatal — next sync will carry all data
  } finally {
    runQueuedSync = state.screenMapSyncQueued;
    state.screenMapSyncQueued = false;
    state.screenMapSyncInFlight = false;
  }

  if (runQueuedSync) return syncScreenMap();
}

export function scheduleScreenMapSync(delayMs = SCREEN_MAP_SYNC_DEBOUNCE_MS) {
  if (!state.elementMapper || state.forceStop) return;

  if (state.screenMapSyncTimer) {
    clearTimeout(state.screenMapSyncTimer);
  }

  state.screenMapSyncTimer = setTimeout(() => {
    state.screenMapSyncTimer = null;
    syncScreenMap();
  }, delayMs);
}

/**
 * Sync screen map during beforeunload using sendBeacon (reliable) or sync XHR (fallback).
 * sendBeacon doesn't support custom headers, so we send uncompressed JSON.
 */
export function syncScreenMapBeacon() {
  if (!state.elementMapper || state.forceStop) return;

  const snapshot = state.elementMapper.getSnapshot();
  if (!snapshot.screens.length) return;

  const payload = safeStringify({
    sessionId: state.sessionId,
    applicationId: state.config.applicationId,
    environment: state.config.environment,
    screens: snapshot.screens,
  });

  const url = `${state.config.collectorUrl}/screen-map/sync`;

  // sendBeacon with Blob (supports Content-Type but not Authorization)
  // Server must accept unauthenticated beacon OR we fall back to sync XHR
  try {
    const XHRConstructor = state.originalXHR || XMLHttpRequest;
    const xhr = new XHRConstructor();
    xhr.open('POST', url, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (state.authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${state.authToken}`);
    }
    xhr.send(payload);
  } catch {
    // Best-effort
  }
}

/**
 * Signal "session complete" to the collector via navigator.sendBeacon, hitting
 * POST /sessions/:id/finalize. The server sets endedAt + marks the ingest outbox
 * `finalizing` (shortened dueAt) so the recorded session is decoded into
 * ClickHouse promptly instead of waiting on the inactivity watchdog.
 *
 * sendBeacon cannot set an Authorization header, so the apiKey travels in the
 * JSON body (the finalize route is self-authenticating). Best-effort and safe to
 * call on endSession() and during pagehide/beforeunload.
 */
export function finalizeSessionBeacon() {
  if (state.forceStop) return;
  const sessionId = state.sessionId;
  if (!sessionId) return;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;

  const url = `${state.config.collectorUrl}/sessions/${encodeURIComponent(sessionId)}/finalize`;
  const payload = safeStringify({
    apiKey: state.config.apiKey,
    sessionId,
    endedAt: Date.now(),
  });

  try {
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
  } catch {
    // Best-effort — nothing more we can do during unload.
  }
}

/**
 * Handle the beforeunload event: flush ALL remaining events.
 * No minimum batch size — sends everything that's buffered.
 * Uses synchronous XMLHttpRequest for reliable delivery during unload.
 */
export function handleUnload() {
  sendNetworkEvents();

  if (state.events.length === 0) return;

  const payload = {
    apiKey: state.config.apiKey,
    userId: state.userId || null,
    sessionId: state.sessionId,
    events: state.events.splice(0),
    meta: state.config.meta,
    applicationId: state.config.applicationId,
    environment: state.config.environment,
  };

  try {
    const XHRConstructor = state.originalXHR || XMLHttpRequest;
    const xhr = new XHRConstructor();
    xhr.open('POST', `${state.config.collectorUrl}/sessions/chunk`, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (state.authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${state.authToken}`);
    }
    xhr.send(safeStringify(payload));
  } catch {
    // Best-effort — nothing more we can do during unload
  }
}
