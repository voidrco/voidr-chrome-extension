import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const storage = new Map();
globalThis.sessionStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = { location: { href: 'https://app.test/', hostname: 'app.test' } };

const { state, resetState } = await import('../src/state.js');
const { authenticateSession } = await import('../src/session.js');

beforeEach(() => {
  storage.clear();
  resetState();
  state.forceStop = false;
  state.sessionId = 'old-session';
  state.userId = 'old-user';
  state.config = { ...state.config, apiKey: 'old-key', collectorUrl: 'https://collector.test' };
});

afterEach(() => {
  delete globalThis.fetch;
  resetState();
});

test('stale authentication cannot overwrite a replacement lifecycle', async () => {
  let release;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ token: 'old-token', sessionId: 'old-server-session' }),
        });
    });

  const authentication = authenticateSession();
  await new Promise((resolve) => setTimeout(resolve, 0));
  resetState();
  state.forceStop = false;
  state.sessionId = 'new-session';
  state.authToken = 'new-token';
  storage.set('voidr_jwt', 'new-token');
  release();

  assert.equal(await authentication, false);
  assert.equal(state.sessionId, 'new-session');
  assert.equal(state.authToken, 'new-token');
  assert.equal(storage.get('voidr_jwt'), 'new-token');
});

test('authentication learns the collector chunk limit', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      token: 'token',
      sessionId: 'server-session',
      ingest: { maxChunkPayloadBytes: 5000 },
    }),
  });

  assert.equal(await authenticateSession(), true);
  assert.equal(state.chunkTargetBytes, 4000);
});
