import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { state, resetState } = await import('../src/state.js');
const { scheduleScreenMapSync, syncScreenMap, logNetworkEvent, sendNetworkEvents } =
  await import('../src/transport.js');

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
    logNetworkEvent({ type: 'xhr', url: 'https://api.test/c', requestId: 'fixed-1', timestamp: 123 });
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
