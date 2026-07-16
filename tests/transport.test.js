import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { state, resetState } = await import('../src/state.js');
const { BODY_TRUNCATION_MARKER } = await import('../src/chunk-planner.js');
const {
  scheduleScreenMapSync,
  syncScreenMap,
  logNetworkEvent,
  sendNetworkEvents,
  sendEvents,
  flushEvents,
  handleUnload,
  refreshAuthToken,
  syncScreenMapBeacon,
} = await import('../src/transport.js');

const screen = {
  fingerprint: 'abc12345',
  name: 'Login',
  url: '/login',
  elements: [{ tag: 'button', role: 'button', action: 'click' }],
};

function createElementMapper() {
  let dirty = true;
  let dirtyVersion = 1;

  return {
    isDirty: () => dirty,
    getDirtyVersion: () => dirtyVersion,
    markDirty: () => {
      dirty = true;
      dirtyVersion += 1;
    },
    clearDirty: (version = dirtyVersion) => {
      if (dirtyVersion <= version) dirty = false;
    },
    getSnapshot: () => ({ screens: [screen] }),
  };
}

function setupState() {
  resetState();
  state.forceStop = false;
  state.sessionId = 'session-test';
  state.authToken = 'token-test';
  state.config = {
    ...state.config,
    collectorUrl: 'https://collector.test',
    applicationId: 'app-test',
    environment: 'principal',
  };
  state.elementMapper = createElementMapper();
}

describe('network event identity', () => {
  beforeEach(setupState);
  afterEach(resetState);

  it('assigns a unique requestId and timestamp to every buffered request', () => {
    logNetworkEvent({ type: 'fetch', url: 'https://api.test/a' });
    logNetworkEvent({ type: 'fetch', url: 'https://api.test/a' });
    logNetworkEvent({ type: 'resource', url: 'https://cdn.test/b.js' });

    const ids = state.networkBuffer.map((r) => r.requestId);
    assert.equal(new Set(ids).size, 3);
    for (const req of state.networkBuffer) {
      assert.ok(typeof req.requestId === 'string' && req.requestId.length > 0);
      assert.ok(typeof req.timestamp === 'number' && req.timestamp > 0);
    }
  });

  it('preserves a caller-provided requestId and timestamp', () => {
    logNetworkEvent({
      type: 'xhr',
      url: 'https://api.test/c',
      requestId: 'fixed-1',
      timestamp: 123,
    });
    assert.equal(state.networkBuffer[0].requestId, 'fixed-1');
    assert.equal(state.networkBuffer[0].timestamp, 123);
  });

  it('keeps requestIds unique across batch flushes', () => {
    for (let i = 0; i < 25; i += 1) {
      logNetworkEvent({ type: 'fetch', url: 'https://api.test/same' });
    }
    sendNetworkEvents();

    const all = state.events
      .filter((e) => e.type === 5 && e.data?.plugin === 'network.batch')
      .flatMap((e) => e.data.payload.requests);
    assert.equal(all.length, 25);
    assert.equal(new Set(all.map((r) => r.requestId)).size, 25);
  });
});

describe('chunk send retry semantics', () => {
  beforeEach(setupState);

  afterEach(() => {
    resetState();
    delete globalThis.fetch;
  });

  function fillEvents(count) {
    for (let i = 0; i < count; i += 1) {
      state.events.push({ type: 3, timestamp: Date.now() + i, data: { i } });
    }
  }

  it('drops the batch on 4xx instead of requeueing it', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return { ok: false, status: 422 };
    };

    fillEvents(20);
    await sendEvents();

    assert.equal(requestCount, 1);
    assert.equal(state.events.length, 0);
    assert.equal(state.isSending, false);
  });

  it('requeues the batch on 5xx', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503 });

    fillEvents(20);
    await sendEvents();

    assert.equal(state.events.length, 20);
    assert.equal(state.isSending, false);
  });

  it('requeues the batch on 408 and 429', async () => {
    for (const status of [408, 429]) {
      globalThis.fetch = async () => ({ ok: false, status });
      fillEvents(20);
      await sendEvents();
      assert.equal(state.events.length, 20);
      state.events.length = 0;
    }
  });

  it('requeues the batch on network error', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('network down');
    };

    fillEvents(20);
    await sendEvents();

    assert.equal(state.events.length, 20);
    assert.equal(state.isSending, false);
  });

  it('flushEvents skips a 4xx-rejected batch and keeps flushing the rest', async () => {
    const statuses = [422, 200];
    let requestCount = 0;
    globalThis.fetch = async () => {
      const status = statuses[requestCount];
      requestCount += 1;
      return { ok: status === 200, status };
    };

    fillEvents(150);
    await flushEvents();

    assert.equal(requestCount, 2);
    assert.equal(state.events.length, 0);
    assert.equal(state.isSending, false);
  });

  it('flushEvents still requeues and stops on 5xx', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });

    fillEvents(150);
    await flushEvents();

    assert.equal(state.events.length, 150);
    assert.equal(state.isSending, false);
  });

  it('invokes onSessionExpired on 409 SESSION_EXPIRED and drops the batch', async () => {
    let expiredReason = null;
    state.onSessionExpired = (reason) => {
      expiredReason = reason;
    };

    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      clone() {
        return this;
      },
      async json() {
        return { error: 'Session exceeded max duration', code: 'SESSION_EXPIRED' };
      },
    });

    fillEvents(20);
    await sendEvents();

    assert.equal(expiredReason, 'server-expired');
    assert.equal(state.events.length, 0);
    assert.equal(state.isSending, false);
  });

  it('does not send while sessionRotationInFlight is set', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return { ok: true, status: 200 };
    };

    state.sessionRotationInFlight = true;
    fillEvents(20);
    await sendEvents();

    assert.equal(requestCount, 0);
    assert.equal(state.events.length, 20);
  });

  it('force-flushes buffered events while paused', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return { ok: true, status: 204 };
    };
    state.isPaused = true;
    fillEvents(5);

    assert.equal(await flushEvents(), true);
    assert.equal(requestCount, 1);
    assert.equal(state.events.length, 0);
  });

  it('waits for an in-flight send even when the queue is empty', async () => {
    let releaseRequest;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseRequest = () => resolve({ ok: true, status: 204 });
      });
    fillEvents(20);

    const send = sendEvents();
    while (!releaseRequest) await new Promise((resolve) => setTimeout(resolve, 0));

    let flushResolved = false;
    const flush = flushEvents().then((result) => {
      flushResolved = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(state.events.length, 0);
    assert.equal(flushResolved, false);

    releaseRequest();
    assert.equal(await flush, true);
    await send;
  });

  it('does not let an old send mutate a replacement lifecycle', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return { ok: true, status: 204 };
    };
    fillEvents(20);
    const oldSend = sendEvents();

    setupState();
    state.events.push({ type: 5, timestamp: Date.now(), data: { plugin: 'new.lifecycle' } });
    await oldSend;

    assert.equal(requestCount, 0);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].data.plugin, 'new.lifecycle');
    assert.equal(state.isSending, false);
  });

  it('rejects a token refresh that completes after the session changes', async () => {
    let release;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, json: async () => ({ token: 'stale-token' }) });
      });

    const refresh = refreshAuthToken();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.sessionId = 'replacement-session';
    state.authToken = 'replacement-token';
    release();

    await assert.rejects(refresh, /Stale token refresh/);
    assert.equal(state.authToken, 'replacement-token');
  });
});

describe('size-aware chunk delivery', () => {
  beforeEach(setupState);

  afterEach(() => {
    resetState();
    delete globalThis.fetch;
  });

  const response = (status, body = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    clone: () => response(status, body),
    json: async () => body,
  });

  const decodeChunk = (body) => JSON.parse(gunzipSync(Buffer.from(body)).toString('utf8'));

  function fillSizedEvents(count, valueBytes = 0) {
    for (let index = 0; index < count; index += 1) {
      state.events.push({
        type: 3,
        timestamp: 1700000000000 + index,
        data: { index, value: 'x'.repeat(valueBytes) },
      });
    }
  }

  it('drains only large network events before they can poison a later chunk', async () => {
    const accepted = [];
    globalThis.fetch = async (_url, options) => {
      accepted.push(decodeChunk(options.body));
      return response(204);
    };

    logNetworkEvent({
      type: 'xhr',
      url: 'https://api.test/large',
      responseBody: 'x'.repeat(600_000),
    });
    while (state.isSending) await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].events[0].data.payload.requests[0].responseBody.length, 600_000);

    logNetworkEvent({ type: 'xhr', url: 'https://api.test/small', responseBody: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(accepted.length, 1);
    assert.equal(state.networkBuffer.length, 1);
  });

  it('partitions proactively by serialized bytes and preserves event order', async () => {
    const accepted = [];
    const payloadSizes = [];
    state.chunkTargetBytes = 900;
    globalThis.fetch = async (_url, options) => {
      const payload = decodeChunk(options.body);
      payloadSizes.push(Buffer.byteLength(JSON.stringify(payload)));
      accepted.push(...payload.events);
      return response(204);
    };

    fillSizedEvents(20, 180);
    await sendEvents();

    assert.ok(payloadSizes.length > 1);
    assert.ok(payloadSizes.every((bytes) => bytes <= 900));
    assert.deepEqual(
      accepted.map(({ data }) => data.index),
      Array.from({ length: 20 }, (_, index) => index),
    );
    assert.equal(state.events.length, 0);
  });

  it('splits network batches by request without discarding their bodies', async () => {
    const accepted = [];
    const requests = Array.from({ length: 4 }, (_, index) => ({
      requestId: `request-${index}`,
      url: `https://api.test/${index}`,
      responseBody: `body-${index}-${'x'.repeat(650)}`,
    }));
    state.chunkTargetBytes = 1300;
    globalThis.fetch = async (_url, options) => {
      accepted.push(...decodeChunk(options.body).events);
      return response(204);
    };

    fillSizedEvents(9);
    state.events.push({
      type: 5,
      timestamp: 1700000000100,
      data: { plugin: 'network.batch', payload: { requests } },
    });
    await sendEvents();

    const delivered = accepted
      .filter(({ data }) => data?.plugin === 'network.batch')
      .flatMap(({ data }) => data.payload.requests);
    assert.deepEqual(delivered, requests);
    assert.equal(state.events.length, 0);
  });

  it('learns the collector limit from 413 and replans the pending batch', async () => {
    const accepted = [];
    let rejected = 0;
    state.chunkTargetBytes = 20_000;
    globalThis.fetch = async (_url, options) => {
      const payload = decodeChunk(options.body);
      const eventBytes = Buffer.byteLength(JSON.stringify(payload.events));
      if (eventBytes > 1200) {
        rejected += 1;
        return response(413, { code: 'CHUNK_TOO_LARGE', maxBytes: 1200 });
      }
      accepted.push(...payload.events);
      return response(204);
    };

    fillSizedEvents(20, 180);
    await sendEvents();

    assert.equal(rejected, 1);
    assert.equal(state.chunkTargetBytes, 960);
    assert.deepEqual(
      accepted.map(({ data }) => data.index),
      Array.from({ length: 20 }, (_, index) => index),
    );
  });

  it('requeues only the unsent suffix after a partial success', async () => {
    const accepted = [];
    let requestCount = 0;
    state.chunkTargetBytes = 900;
    globalThis.fetch = async (_url, options) => {
      requestCount += 1;
      const events = decodeChunk(options.body).events;
      if (requestCount === 2) return response(503);
      accepted.push(...events.map(({ data }) => data.index));
      return response(204);
    };

    fillSizedEvents(20, 180);
    await sendEvents();
    const retryIndexes = state.events.map(({ data }) => data.index);

    assert.ok(accepted.length > 0);
    assert.ok(retryIndexes.length > 0);
    assert.deepEqual(
      [...accepted, ...retryIndexes],
      Array.from({ length: 20 }, (_, index) => index),
    );

    globalThis.fetch = async (_url, options) => {
      accepted.push(...decodeChunk(options.body).events.map(({ data }) => data.index));
      return response(204);
    };
    await flushEvents();
    assert.deepEqual(
      accepted,
      Array.from({ length: 20 }, (_, index) => index),
    );
  });

  it('reuses one refreshed token across every planned chunk', async () => {
    const accepted = [];
    let refreshCount = 0;
    let oldTokenChunkCalls = 0;
    state.chunkTargetBytes = 900;
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/refresh-token')) {
        refreshCount += 1;
        return { ok: true, status: 200, json: async () => ({ token: 'token-refreshed' }) };
      }
      if (options.headers.Authorization === 'Bearer token-test') {
        oldTokenChunkCalls += 1;
        return response(401);
      }
      accepted.push(...decodeChunk(options.body).events.map(({ data }) => data.index));
      return response(204);
    };

    fillSizedEvents(20, 180);
    await sendEvents();

    assert.equal(refreshCount, 1);
    assert.equal(oldTokenChunkCalls, 1);
    assert.deepEqual(
      accepted,
      Array.from({ length: 20 }, (_, index) => index),
    );
  });

  it('pauses between planned chunks and requeues only the remaining suffix', async () => {
    const accepted = [];
    state.chunkTargetBytes = 900;
    globalThis.fetch = async (_url, options) => {
      accepted.push(...decodeChunk(options.body).events.map(({ data }) => data.index));
      return {
        status: 204,
        get ok() {
          state.isPaused = true;
          return true;
        },
      };
    };

    fillSizedEvents(20, 180);
    await sendEvents();

    const queued = state.events.map(({ data }) => data.index);
    assert.ok(accepted.length > 0);
    assert.ok(queued.length > 0);
    assert.deepEqual(
      [...accepted, ...queued],
      Array.from({ length: 20 }, (_, index) => index),
    );
  });

  it('stops a planned delivery without mutating a replacement lifecycle', async () => {
    let requestCount = 0;
    state.chunkTargetBytes = 900;
    globalThis.fetch = async () => {
      requestCount += 1;
      return {
        status: 204,
        get ok() {
          setupState();
          state.events.push({ type: 5, timestamp: Date.now(), data: { plugin: 'replacement' } });
          return true;
        },
      };
    };

    fillSizedEvents(20, 180);
    await sendEvents();

    assert.equal(requestCount, 1);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].data.plugin, 'replacement');
    assert.equal(state.isSending, false);
  });

  it('truncates only the largest body of an indivisible request', async () => {
    const accepted = [];
    globalThis.fetch = async (_url, options) => {
      const events = decodeChunk(options.body).events;
      const networkRequest = events.find(({ data }) => data?.plugin === 'network.batch')?.data
        .payload.requests[0];
      if (networkRequest?.responseBody?.length > 1000) {
        return response(413, { code: 'CHUNK_TOO_LARGE', maxBytes: 1600 });
      }
      accepted.push(...events);
      return response(204);
    };

    fillSizedEvents(9);
    state.events.push({
      type: 5,
      timestamp: 1700000000100,
      data: {
        plugin: 'network.batch',
        payload: {
          requests: [
            {
              requestId: 'request-1',
              requestBody: 'q'.repeat(500),
              responseBody: 'r'.repeat(2000),
            },
          ],
        },
      },
    });
    await sendEvents();

    const delivered = accepted.find(({ data }) => data?.plugin === 'network.batch').data.payload
      .requests[0];
    assert.equal(delivered.responseBody, BODY_TRUNCATION_MARKER);
    assert.equal(delivered.requestBody, 'q'.repeat(500));
    assert.equal(delivered.responseBodyTruncated, true);
  });

  it('requeues the already-truncated request after a transient failure', async () => {
    let truncatedAttempts = 0;
    globalThis.fetch = async (_url, options) => {
      const request = decodeChunk(options.body).events[0].data.payload.requests[0];
      if (request.responseBody !== BODY_TRUNCATION_MARKER) {
        return response(413, { maxBytes: 1000 });
      }
      truncatedAttempts += 1;
      return response(503);
    };
    state.events.push({
      type: 5,
      timestamp: 1700000000000,
      data: {
        plugin: 'network.batch',
        payload: {
          requests: [{ requestId: 'request-1', responseBody: 'x'.repeat(2000) }],
        },
      },
    });

    await sendEvents();

    assert.equal(truncatedAttempts, 1);
    assert.equal(state.events[0].data.payload.requests[0].responseBody, BODY_TRUNCATION_MARKER);
  });

  it('bounds repeated 413 responses instead of creating a request storm', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return response(413);
    };

    fillSizedEvents(100, 50);
    await sendEvents();

    assert.equal(requestCount, 8);
    assert.equal(state.events.length, 0);
    assert.equal(state.isSending, false);
  });
});

describe('unload delivery', () => {
  beforeEach(setupState);

  afterEach(() => {
    resetState();
    delete globalThis.fetch;
    delete globalThis.window;
    delete globalThis.XMLHttpRequest;
  });

  it('never falls back to a synchronous XHR for an oversized keepalive body', () => {
    let options = null;
    globalThis.window = {};
    globalThis.fetch = async (_url, requestOptions) => {
      options = requestOptions;
      return { ok: true, status: 204 };
    };
    state.events.push({
      type: 3,
      timestamp: Date.now(),
      data: { value: randomBytes(100_000).toString('base64') },
    });

    handleUnload();

    assert.equal(options.keepalive, false);
    assert.equal(options.headers['Content-Encoding'], 'gzip');
    assert.equal(state.events.length, 0);
  });

  it('never uses synchronous XHR for an oversized screen map', () => {
    let options = null;
    globalThis.window = {};
    globalThis.fetch = async (_url, requestOptions) => {
      options = requestOptions;
      return { ok: true, status: 204 };
    };
    globalThis.XMLHttpRequest = class {
      constructor() {
        throw new Error('synchronous XHR must not be constructed');
      }
    };
    state.elementMapper = {
      getSnapshot: () => ({
        screens: [{ ...screen, payload: randomBytes(100_000).toString('base64') }],
      }),
    };

    syncScreenMapBeacon();

    assert.equal(options.keepalive, false);
    assert.equal(options.headers['Content-Encoding'], 'gzip');
  });
});

describe('screen map transport sync coalescing', () => {
  beforeEach(setupState);

  afterEach(() => {
    if (state.screenMapSyncTimer) clearTimeout(state.screenMapSyncTimer);
    resetState();
    delete globalThis.fetch;
  });

  it('coalesces concurrent sync calls into a single request', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, status: 204 };
    };

    await Promise.all(Array.from({ length: 50 }, () => syncScreenMap()));

    assert.equal(requestCount, 1);
    assert.equal(state.screenMapSyncInFlight, false);
    assert.equal(state.screenMapSyncQueued, false);
    assert.equal(state.elementMapper.isDirty(), false);
  });

  it('runs one follow-up sync when data changes during an in-flight request', async () => {
    let requestCount = 0;
    let releaseFirstRequest;
    globalThis.fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise((resolve) => {
          releaseFirstRequest = resolve;
        });
      }
      return { ok: true, status: 204 };
    };

    const firstSync = syncScreenMap();
    await new Promise((resolve) => setTimeout(resolve, 0));

    state.elementMapper.markDirty();
    await syncScreenMap();
    releaseFirstRequest();
    await firstSync;

    assert.equal(requestCount, 2);
    assert.equal(state.screenMapSyncInFlight, false);
    assert.equal(state.screenMapSyncQueued, false);
    assert.equal(state.elementMapper.isDirty(), false);
  });

  it('does not clear mapper state after the session changes', async () => {
    let release;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 204 });
      });

    const sync = syncScreenMap();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.sessionId = 'replacement-session';
    release();
    await sync;

    assert.equal(state.elementMapper.isDirty(), true);
  });

  it('debounces scheduled route syncs into one request', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return { ok: true, status: 204 };
    };

    for (let i = 0; i < 50; i += 1) {
      scheduleScreenMapSync(5);
    }

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(requestCount, 1);
    assert.equal(state.elementMapper.isDirty(), false);
  });
});
