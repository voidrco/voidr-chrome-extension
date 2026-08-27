import { gzip } from 'pako';
import { state } from './state.js';
import { safeStringify } from './utils/helpers.js';
import { compressEventsBase64 } from './utils/image-compression.js';
import { TOKEN_REFRESH_MARGIN_MS, decodeJwtExp } from './utils/jwt.js';
import { notifyBufferTrigger } from './buffer-mode.js';
import { recordLiveContext } from './live-context.js';
import {
  DEFAULT_CHUNK_TARGET_BYTES,
  isNetworkBatchEvent,
  materializeChunkItem,
  planChunkBatch,
  planChunkItem,
  replanChunkItems,
  retryEventsForChunks,
  targetChunkBytes,
  truncateLargestNetworkBody,
} from './chunk-planner.js';

const SCREEN_MAP_SYNC_DEBOUNCE_MS = 2000;

// fetch keepalive bodies share a ~64KB in-flight quota; leave headroom.
const KEEPALIVE_BODY_LIMIT = 60 * 1024;

// Payloads above this compress off the main thread via CompressionStream;
// smaller ones use pako synchronously (cheaper than the stream setup).
const NATIVE_COMPRESSION_THRESHOLD = 50 * 1024;
const MAX_CHUNK_413_RESPONSES = 8;
const LARGE_CHUNK_YIELD_BYTES = 512 * 1024;
const LARGE_NETWORK_EVENT_BYTES = 1024 * 1024;
const MIN_NETWORK_BATCH_TARGET_BYTES = 256 * 1024;

/**
 * Gzip a string using the native CompressionStream for large payloads (keeps
 * the main thread free), falling back to pako.
 */
async function gzipBytes(str) {
  if (
    str.length >= NATIVE_COMPRESSION_THRESHOLD &&
    typeof CompressionStream === 'function' &&
    typeof Response === 'function'
  ) {
    try {
      const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      /* fall through to pako */
    }
  }
  return gzip(str);
}

// 408 and 429 are transient; 413 is handled by the bounded replanner.
function isNonRetryableStatus(status) {
  return status >= 400 && status < 500 && ![408, 413, 429].includes(status);
}

/**
 * Detect SESSION_EXPIRED on a chunk response and kick off session rotation.
 * Single-flight: concurrent 409s share one rotation.
 */
async function handleSessionExpiredResponse(
  res,
  lifecycleId = state.lifecycleId,
  sessionId = state.sessionId,
) {
  if (res.status !== 409) return false;

  let code = null;
  try {
    const body = await res.clone().json();
    code = body?.code || null;
  } catch {
    /* body may be empty or non-JSON */
  }

  // /sessions/chunk uses 409 for the max-duration cap; treat unknown 409 the
  // same way so a missing body still recovers instead of looping forever.
  if (code && code !== 'SESSION_EXPIRED') return false;

  if (state.lifecycleId !== lifecycleId || state.sessionId !== sessionId || state.forceStop)
    return false;
  console.warn('VoidrCollector: Session expired server-side, rotating session');
  const onExpired = state.onSessionExpired;
  if (typeof onExpired === 'function') {
    onExpired('server-expired');
  }
  return true;
}

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
export function refreshAuthToken(lifecycleId = state.lifecycleId, sessionId = state.sessionId) {
  if (refreshInFlight?.lifecycleId === lifecycleId && refreshInFlight?.sessionId === sessionId)
    return refreshInFlight.promise;
  const collectorUrl = state.config.collectorUrl;
  const apiKey = state.config.apiKey;
  const promise = (async () => {
    const refreshResponse = await fetch(`${collectorUrl}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: safeStringify({ apiKey }),
    });
    if (!refreshResponse.ok) {
      throw new Error('VoidrCollector: Failed to refresh token');
    }
    const data = await refreshResponse.json().catch(() => ({}));
    const token = data.token || null;
    if (!token) {
      throw new Error('VoidrCollector: Failed to refresh token');
    }
    if (state.lifecycleId !== lifecycleId || state.sessionId !== sessionId || state.forceStop) {
      throw new Error('VoidrCollector: Stale token refresh');
    }
    state.authToken = token;
    try {
      sessionStorage.setItem('voidr_jwt', token);
    } catch (_) {}
    scheduleTokenRefresh();
    return token;
  })().finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { lifecycleId, sessionId, promise };
  return promise;
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
      refreshAuthToken().catch(() => {});
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

  // App-provided sanitizer (OpenReplay-style): may mutate/replace the event
  // or return null to drop it entirely.
  if (typeof state.config.networkSanitizer === 'function') {
    try {
      const sanitized = state.config.networkSanitizer(data);
      if (sanitized === null) return;
      if (sanitized && typeof sanitized === 'object') data = sanitized;
    } catch {
      /* sanitizer bugs must not break capture */
    }
  }

  recordLiveContext('requests', data, { id: data.requestId, timestamp: data.timestamp });

  const bodyBytes = ['requestBody', 'responseBody', 'response'].reduce(
    (total, field) => total + (typeof data[field] === 'string' ? data[field].length * 2 : 0),
    2048,
  );
  const targetBytes = Math.max(
    MIN_NETWORK_BATCH_TARGET_BYTES,
    state.chunkTargetBytes || DEFAULT_CHUNK_TARGET_BYTES,
  );
  if (state.networkBuffer.length > 0 && state.networkBufferBytes + bodyBytes > targetBytes) {
    sendNetworkEvents();
  }
  state.networkBuffer.push(data);
  state.networkBufferBytes += bodyBytes;
  if (state.networkBuffer.length > 10 || state.networkBufferBytes >= targetBytes) {
    sendNetworkEvents();
  }
  if (bodyBytes >= LARGE_NETWORK_EVENT_BYTES) {
    sendNetworkEvents();
    void sendEvents();
  }

  if (data.type === 'fetchError' || (typeof data.status === 'number' && data.status >= 500)) {
    notifyBufferTrigger('network-error');
  }
}

/**
 * Flush the network buffer into the main events array as a batch event.
 */
export function sendNetworkEvents() {
  if (state.networkBuffer.length === 0) {
    state.networkBufferBytes = 0;
    return;
  }

  const requests = state.networkBuffer.splice(0);
  state.networkBufferBytes = 0;
  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin: 'network.batch',
      payload: {
        requests,
      },
    },
  });
}

function createChunkContext() {
  return {
    lifecycleId: state.lifecycleId,
    collectorUrl: state.config.collectorUrl,
    authToken: state.authToken,
    userId: state.userId || null,
    sessionId: state.sessionId,
    userTraits: state.config.user,
    maskedElements: state.config.dataMasking.blockSelectors,
    sessionTimeout: state.config.sessionTimeout,
    meta: state.config.meta,
    applicationId: state.config.applicationId,
    environment: state.config.environment,
    chunkTargetBytes: state.chunkTargetBytes || DEFAULT_CHUNK_TARGET_BYTES,
  };
}

const isChunkContextCurrent = (context) =>
  state.lifecycleId === context.lifecycleId &&
  state.sessionId === context.sessionId &&
  !state.forceStop;

function createChunkPayload(context, events) {
  return {
    userId: context.userId,
    sessionId: context.sessionId,
    userTraits: context.userTraits,
    events,
    maskedElements: context.maskedElements,
    sessionTimeout: context.sessionTimeout,
    startedAt: events[0]?.timestamp ?? Date.now(),
    endedAt: events[events.length - 1]?.timestamp ?? Date.now(),
    meta: context.meta,
    applicationId: context.applicationId,
    environment: context.environment,
  };
}

async function postChunk(context, body, token = context.authToken) {
  return fetch(`${context.collectorUrl}/sessions/chunk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

const isPausedForSend = (allowPaused) => state.isPaused && !allowPaused;

async function transmitChunk(item, context, { allowPaused, authToken }) {
  const body = await gzipBytes(item.serializedPayload);
  if (!isChunkContextCurrent(context)) return { outcome: 'stale', authToken };
  if (isPausedForSend(allowPaused)) return { outcome: 'paused', authToken };

  let token = authToken;
  let response = await postChunk(context, body, token);
  if (!isChunkContextCurrent(context)) return { outcome: 'stale', authToken: token };
  if (response.status === 401) {
    token = await refreshAuthToken(context.lifecycleId, context.sessionId);
    if (!isChunkContextCurrent(context)) return { outcome: 'stale', authToken: token };
    response = await postChunk(context, body, token);
  }
  if (!isChunkContextCurrent(context)) return { outcome: 'stale', authToken: token };
  if (await handleSessionExpiredResponse(response, context.lifecycleId, context.sessionId)) {
    return { outcome: 'expired', authToken: token };
  }
  if (response.ok) {
    const acknowledgedSequence = Number(response.headers?.get?.('x-voidr-chunk-seq'));
    return {
      outcome: 'sent',
      authToken: token,
      acknowledgedSequence:
        Number.isInteger(acknowledgedSequence) && acknowledgedSequence >= 1
          ? acknowledgedSequence
          : null,
    };
  }
  if (response.status === 413) return { outcome: 'oversized', response, authToken: token };
  if (isNonRetryableStatus(response.status)) {
    return { outcome: 'dropped', response, authToken: token };
  }
  return { outcome: 'retry', response, authToken: token };
}

async function readRejectedMaxBytes(response) {
  try {
    const copy = typeof response.clone === 'function' ? response.clone() : response;
    const body = await copy.json();
    const maxBytes = Number(body?.maxBytes);
    return Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null;
  } catch {
    return null;
  }
}

function reducedChunkTarget(currentTarget, item, reportedMaxBytes) {
  if (reportedMaxBytes) return Math.min(currentTarget, targetChunkBytes(reportedMaxBytes));
  return Math.max(1, Math.min(currentTarget - 1, Math.floor(item.byteLength / 2)));
}

const planMadeProgress = (item, planned) =>
  planned.length > 1 ||
  planned[0]?.wireEvents.length !== item.wireEvents.length ||
  planned[0]?.byteLength < item.byteLength;

const yieldToMainThread = () =>
  typeof globalThis.scheduler?.yield === 'function'
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));

function adaptOversizedQueue(queue, targetBytes, serializePayload) {
  const [current, ...remaining] = queue;
  const options = { targetBytes, serializePayload };
  const plannedCurrent = planChunkItem(current, options);
  const plannedRemaining = replanChunkItems(remaining, options);
  if (planMadeProgress(current, plannedCurrent)) {
    return { queue: [...plannedCurrent, ...plannedRemaining], droppedEvents: 0 };
  }

  const truncated = truncateLargestNetworkBody(current, serializePayload);
  if (truncated) return { queue: [truncated, ...plannedRemaining], droppedEvents: 0 };
  console.warn('VoidrCollector: dropping indivisible event rejected as oversized', {
    type: current.wireEvents[0]?.type,
  });
  return { queue: plannedRemaining, droppedEvents: current.retryEvents.length };
}

async function deliverBatch(batch, context, { allowPaused = false } = {}) {
  let queue = null;
  try {
    const wireEvents = await compressEventsBase64(batch);
    if (!isChunkContextCurrent(context)) return { outcome: 'stale' };
    if (isPausedForSend(allowPaused)) return { outcome: 'paused', requeue: batch };

    const serializePayload = (events) => safeStringify(createChunkPayload(context, events));
    let targetBytes = context.chunkTargetBytes;
    queue = planChunkBatch({
      wireEvents,
      retryEvents: batch,
      targetBytes,
      serializePayload,
    });
    let authToken = context.authToken;
    let oversizedResponses = 0;
    let droppedEvents = 0;
    let rejection = null;

    while (queue.length > 0) {
      if (!isChunkContextCurrent(context)) return { outcome: 'stale' };
      if (isPausedForSend(allowPaused)) {
        return { outcome: 'paused', requeue: retryEventsForChunks(queue) };
      }
      if (queue[0].serializedPayload == null) {
        if (queue[0].byteLength >= LARGE_CHUNK_YIELD_BYTES) await yieldToMainThread();
        if (!isChunkContextCurrent(context)) return { outcome: 'stale' };
        if (isPausedForSend(allowPaused)) {
          return { outcome: 'paused', requeue: retryEventsForChunks(queue) };
        }
        queue[0] = materializeChunkItem(queue[0], serializePayload);
      }

      const result = await transmitChunk(queue[0], context, { allowPaused, authToken });
      authToken = result.authToken || authToken;
      if (result.outcome === 'sent') {
        if (result.acknowledgedSequence != null) {
          state.lastAcknowledgedChunkSeq = Math.max(
            state.lastAcknowledgedChunkSeq,
            result.acknowledgedSequence,
          );
        }
        queue.shift();
        continue;
      }
      if (result.outcome !== 'oversized') {
        if (result.outcome === 'retry' || result.outcome === 'paused') {
          result.requeue = retryEventsForChunks(queue);
        }
        if (result.outcome === 'dropped') {
          result.droppedEvents = droppedEvents + retryEventsForChunks(queue).length;
        }
        return result;
      }

      rejection = result.response;
      oversizedResponses += 1;
      if (oversizedResponses >= MAX_CHUNK_413_RESPONSES) {
        droppedEvents += retryEventsForChunks(queue).length;
        console.warn('VoidrCollector: collector kept rejecting bounded chunk retries', {
          attempts: oversizedResponses,
          events: droppedEvents,
        });
        queue = [];
        break;
      }

      const reportedMaxBytes = await readRejectedMaxBytes(result.response);
      if (!isChunkContextCurrent(context)) return { outcome: 'stale' };
      targetBytes = reducedChunkTarget(targetBytes, queue[0], reportedMaxBytes);
      state.chunkTargetBytes = targetBytes;
      const adapted = adaptOversizedQueue(queue, targetBytes, serializePayload);
      queue = adapted.queue;
      droppedEvents += adapted.droppedEvents;
    }

    return droppedEvents > 0
      ? { outcome: 'dropped', response: rejection, droppedEvents }
      : { outcome: 'sent' };
  } catch (error) {
    return {
      outcome: 'retry',
      error,
      requeue: queue ? retryEventsForChunks(queue) : batch,
    };
  }
}

function completeBatch({ batch, context, result, logErrors }) {
  if (!isChunkContextCurrent(context)) return;
  if (result.outcome === 'paused' || result.outcome === 'retry') {
    state.events.unshift(...(result.requeue || batch));
  }
  if (result.outcome === 'dropped') {
    state.permanentTransportError = `Collector rejected a session chunk with HTTP ${
      result.response?.status ?? 'unknown'
    }`;
    console.debug('VoidrCollector: chunk rejected by collector, dropping batch', {
      status: result.response?.status,
      events: result.droppedEvents ?? batch.length,
    });
  }
  if (logErrors && result.outcome === 'retry') {
    console.error('VoidrCollector: Failed to send events', result.error || result.response?.status);
  }
}

export async function sendEvents() {
  const MIN_BATCH_SIZE = 10;
  if (
    state.isSending ||
    state.sessionRotationInFlight ||
    (state.events.length < MIN_BATCH_SIZE && !state.events.some(isNetworkBatchEvent)) ||
    state.forceStop ||
    state.isPaused
  )
    return;

  const context = createChunkContext();
  const batch = state.events.splice(0, 100);
  const sendingToken = {};
  state.isSending = true;
  state.sendingToken = sendingToken;
  const result = await deliverBatch(batch, context);
  completeBatch({ batch, context, result, logErrors: true });
  if (state.sendingToken === sendingToken) {
    state.isSending = false;
    state.sendingToken = null;
  }
}

export async function flushEvents({ allowRotation = false } = {}) {
  sendNetworkEvents();
  const lifecycleId = state.lifecycleId;
  const sessionId = state.sessionId;
  const isCurrentSession = () =>
    state.lifecycleId === lifecycleId && state.sessionId === sessionId && !state.forceStop;
  const rotationBlocks = () => state.sessionRotationInFlight && !allowRotation;
  if (state.forceStop || rotationBlocks() || state.permanentTransportError) return false;

  while (state.isSending && isCurrentSession()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!isCurrentSession() || rotationBlocks()) return false;
  if (state.events.length === 0) return true;

  while (state.events.length > 0 && isCurrentSession() && !rotationBlocks()) {
    const context = createChunkContext();
    const batch = state.events.splice(0, 100);
    const sendingToken = {};
    state.isSending = true;
    state.sendingToken = sendingToken;
    const result = await deliverBatch(batch, context, { allowPaused: true });
    completeBatch({ batch, context, result, logErrors: false });
    if (state.sendingToken === sendingToken) {
      state.isSending = false;
      state.sendingToken = null;
    }
    if (result.outcome !== 'sent') break;
  }
  return (
    state.events.length === 0 &&
    !state.isSending &&
    !state.permanentTransportError &&
    isCurrentSession()
  );
}

/**
 * Sync the screen map to the dedicated /screen-map/sync endpoint.
 * Only sends if the ElementMapper has new data since last sync (dirty flag).
 * Failures are non-fatal — recording continues normally.
 */
export async function syncScreenMap() {
  if (!state.elementMapper || state.forceStop || state.isPaused || state.sessionRotationInFlight)
    return;
  if (!state.elementMapper.isDirty()) return;
  if (state.screenMapSyncInFlight) {
    state.screenMapSyncQueued = true;
    return;
  }

  state.screenMapSyncInFlight = true;
  const lifecycleId = state.lifecycleId;
  const elementMapper = state.elementMapper;
  const collectorUrl = state.config.collectorUrl;
  const authToken = state.authToken;
  const sessionId = state.sessionId;
  const applicationId = state.config.applicationId;
  const environment = state.config.environment;
  const isCurrentSync = () =>
    state.lifecycleId === lifecycleId &&
    state.sessionId === sessionId &&
    state.elementMapper === elementMapper &&
    !state.sessionRotationInFlight &&
    !state.forceStop;
  let runQueuedSync = false;

  try {
    const dirtyVersion =
      typeof elementMapper.getDirtyVersion === 'function'
        ? elementMapper.getDirtyVersion()
        : undefined;
    const snapshot = elementMapper.getSnapshot();
    if (!snapshot.screens.length) return;

    const payload = safeStringify({
      sessionId,
      applicationId,
      environment,
      screens: snapshot.screens,
    });

    const compressed = await gzipBytes(payload);
    if (!isCurrentSync() || state.isPaused) return;

    let res = await fetch(`${collectorUrl}/screen-map/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: compressed,
    });

    // Fallback: token expired/revoked mid-sync — refresh and retry once.
    if (res.status === 401) {
      try {
        const token = await refreshAuthToken(lifecycleId, sessionId);
        if (!isCurrentSync() || state.isPaused) return;
        res = await fetch(`${collectorUrl}/screen-map/sync`, {
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

    if ((res.ok || res.status === 204) && isCurrentSync() && !state.isPaused) {
      elementMapper.clearDirty(dirtyVersion);
    }
  } catch {
    // Non-fatal — next sync will carry all data
  } finally {
    if (state.lifecycleId === lifecycleId) {
      runQueuedSync = state.screenMapSyncQueued;
      state.screenMapSyncQueued = false;
      state.screenMapSyncInFlight = false;
    }
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
 * Sync screen map during unload without blocking navigation.
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

  try {
    const compressed = gzip(payload);
    const doFetch = state.originalFetch || fetch;
    Promise.resolve(
      doFetch.call(window, url, {
        method: 'POST',
        keepalive: compressed.byteLength < KEEPALIVE_BODY_LIMIT,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
        },
        body: compressed,
      }),
    ).catch(() => {});
  } catch {}
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
    finalizationMode: 'unload-beacon',
  });

  try {
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
  } catch {
    // Best-effort — nothing more we can do during unload.
  }
}

// Seal only through the highest contiguous server-acknowledged chunk.
export async function finalizeSessionExplicit({
  lifecycleId = state.lifecycleId,
  sessionId = state.sessionId,
  maxAttempts = 3,
} = {}) {
  if (!sessionId || state.lifecycleId !== lifecycleId) {
    return { sealed: false, code: 'STALE_SESSION' };
  }
  const finalizedThrough = state.lastAcknowledgedChunkSeq;
  if (!Number.isInteger(finalizedThrough) || finalizedThrough < 1) {
    return { sealed: false, code: 'FINAL_WATERMARK_UNAVAILABLE' };
  }
  const collectorUrl = state.config.collectorUrl;
  let authToken = state.authToken;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(
        `${collectorUrl}/sessions/${encodeURIComponent(sessionId)}/finalize`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: safeStringify({
            sessionId,
            endedAt: Date.now(),
            finalizationMode: 'explicit-stop',
            finalizedThrough,
            finalChunkSeq: finalizedThrough,
          }),
        },
      );
      if (response.status === 401 && attempt === 0) {
        authToken = await refreshAuthToken(lifecycleId, sessionId);
        continue;
      }
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.sealed === true) return data;
      if (response.status >= 400 && response.status < 500 && response.status !== 409) {
        return { sealed: false, status: response.status, ...data };
      }
      lastError = { status: response.status, ...data };
    } catch (error) {
      lastError = { error: error instanceof Error ? error.message : String(error) };
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  return { sealed: false, code: 'FINALIZE_RETRY_EXHAUSTED', ...(lastError || {}) };
}

/**
 * Flush remaining events without blocking navigation.
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
  const body = safeStringify(payload);

  try {
    const compressed = gzip(body, { level: 1 });
    const doFetch = state.originalFetch || fetch;
    Promise.resolve(
      doFetch.call(window, `${state.config.collectorUrl}/sessions/chunk`, {
        method: 'POST',
        keepalive: compressed.byteLength < KEEPALIVE_BODY_LIMIT,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
        },
        body: compressed,
      }),
    ).catch(() => {});
  } catch {}
}
