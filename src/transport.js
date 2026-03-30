import { gzip } from 'pako';
import { state } from './state.js';
import { safeStringify } from './utils/helpers.js';
import { compressEventsBase64 } from './utils/image-compression.js';

/**
 * Buffer a network event. Flushes automatically when buffer exceeds 10 entries.
 */
export function logNetworkEvent(data) {
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
  if (state.isSending || state.events.length < MIN_BATCH_SIZE || state.forceStop) return;
  state.isSending = true;

  const batch = state.events.splice(0, 100);
  const compressedBatch = await compressEventsBase64(batch);

  const startedAt = compressedBatch[0]?.timestamp ?? Date.now();
  const endedAt =
    compressedBatch[compressedBatch.length - 1]?.timestamp ?? Date.now();

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

    // Handle 401 - refresh token and retry
    if (res.status === 401) {
      const refreshResponse = await fetch(`${state.config.collectorUrl}/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeStringify({
          apiKey: state.config.apiKey,
        }),
      });
      if (!refreshResponse.ok) {
        throw new Error('VoidrCollector: Failed to refresh token');
      }
      const data = await refreshResponse.json().catch(() => ({}));
      state.authToken = data.token || null;
      if (!state.authToken) {
        throw new Error('VoidrCollector: Failed to refresh token');
      }
      sessionStorage.setItem('voidr_jwt', state.authToken);
      // Retry the original request with new token
      res = await fetch(`${state.config.collectorUrl}/sessions/chunk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          Authorization: `Bearer ${state.authToken}`,
        },
        body: compressed,
      });
    }

    if (!res.ok) {
      throw new Error('VoidrCollector: Failed to send events');
    }
  } catch (error) {
    console.error('VoidrCollector: Failed to send events', error);
    state.stopRecording();
    state.forceStop = true;
    sessionStorage.removeItem('voidr_session_id');
    sessionStorage.removeItem('voidr_user_id');
    sessionStorage.removeItem('voidr_jwt');
    clearInterval(state.eventsInterval);
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
