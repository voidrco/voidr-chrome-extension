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
 * Handle the beforeunload event: flush network events and attempt to send remaining events.
 * Uses synchronous XMLHttpRequest as fallback to ensure delivery.
 */
export function handleUnload() {
  sendNetworkEvents();
  // Respect minimum event count before sending
  sendEvents();

  // Synchronous send as fallback (uses original XMLHttpRequest to avoid logging as network event)
  if (state.events.length > 0) {
    const payload = {
      apiKey: state.config.apiKey,
      userId: state.userId || null,
      sessionId: state.sessionId,
      events: state.events,
      meta: state.config.meta,
      applicationId: state.config.applicationId,
      environment: state.config.environment,
    };

    const XHRConstructor = state.originalXHR || XMLHttpRequest;
    const xhr = new XHRConstructor();
    xhr.open('POST', `${state.config.collectorUrl}/sessions/chunk`, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (state.authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${state.authToken}`);
    }
    xhr.send(safeStringify(payload));
  }
}
