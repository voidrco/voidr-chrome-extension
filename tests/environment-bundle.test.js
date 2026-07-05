import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { state, resetState } = await import('../src/state.js');
const { buildEnvironmentBundle, sendEnvironmentBundle } = await import(
  '../src/environment-bundle.js'
);

function makeStorage(entries) {
  const map = new Map(Object.entries(entries));
  const keys = () => Array.from(map.keys());
  return {
    get length() {
      return map.size;
    },
    key: (i) => keys()[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function setupDom({ cookie = '', local = {}, session = {} } = {}) {
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 720,
    location: {
      href: 'https://app.co/dashboard?x=1',
      origin: 'https://app.co',
      hostname: 'app.co',
      protocol: 'https:',
    },
    localStorage: makeStorage(local),
    sessionStorage: makeStorage(session),
  };
  globalThis.document = { cookie };
  // In modern Node `globalThis.navigator` is a read-only accessor, so plain
  // assignment throws — define it as a configurable value instead.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'UA-test', language: 'pt-BR' },
    configurable: true,
    writable: true,
  });
  globalThis.sessionStorage = globalThis.window.sessionStorage;
}

function teardownDom() {
  delete globalThis.window;
  delete globalThis.document;
  try {
    delete globalThis.navigator;
  } catch (_) {
    /* accessor-only in some runtimes */
  }
  delete globalThis.sessionStorage;
  delete globalThis.fetch;
}

function setupState() {
  resetState();
  state.forceStop = false;
  state.sessionId = 'sess-env-1';
  state.authToken = 'token-env';
  state.config = {
    ...state.config,
    collectorUrl: 'https://collector.test',
    apiKey: 'key-env',
    captureEnvironmentBundle: true,
  };
}

describe('buildEnvironmentBundle', () => {
  beforeEach(() => {
    setupState();
    setupDom({
      cookie: 'sid=abc; theme=dark',
      local: { token: 'jwt-value', flag: '1' },
      session: { tmp: 'x' },
    });
  });
  afterEach(() => {
    resetState();
    teardownDom();
  });

  it('captures storage, cookies, viewport, UA and URL in Playwright storageState shape', () => {
    const b = buildEnvironmentBundle();
    assert.equal(b.sessionId, 'sess-env-1');
    assert.equal(b.baseUrl, 'https://app.co/dashboard?x=1');
    assert.equal(b.userAgent, 'UA-test');
    assert.deepEqual(b.viewport, { width: 1280, height: 720 });

    const cookieNames = b.storageState.cookies.map((c) => c.name).sort();
    assert.deepEqual(cookieNames, ['sid', 'theme']);
    // document.cookie can only see non-HttpOnly cookies — mark them accordingly.
    assert.ok(b.storageState.cookies.every((c) => c.httpOnly === false));

    const origin = b.storageState.origins[0];
    assert.equal(origin.origin, 'https://app.co');
    assert.deepEqual(
      origin.localStorage.map((e) => e.name).sort(),
      ['flag', 'token'],
    );
    assert.deepEqual(origin.sessionStorage, [{ name: 'tmp', value: 'x' }]);
  });
});

describe('sendEnvironmentBundle', () => {
  beforeEach(() => {
    setupState();
    setupDom({ cookie: 'sid=abc' });
  });
  afterEach(() => {
    resetState();
    teardownDom();
  });

  it('POSTs the bundle to the dedicated endpoint with the collector token', async () => {
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 204 };
    };

    await sendEnvironmentBundle();

    assert.equal(
      captured.url,
      'https://collector.test/sessions/sess-env-1/environment-bundle',
    );
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.Authorization, 'Bearer token-env');
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.sessionId, 'sess-env-1');
    assert.equal(body.source, 'collector-script');
  });

  it('is a no-op when captureEnvironmentBundle is disabled', async () => {
    state.config.captureEnvironmentBundle = false;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 204 };
    };
    await sendEnvironmentBundle();
    assert.equal(called, false);
  });

  it('refreshes the token once on 401 and retries', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/environment-bundle') && calls.filter((u) => u.endsWith('/environment-bundle')).length === 1) {
        return { ok: false, status: 401 };
      }
      if (url.endsWith('/refresh-token')) {
        return { ok: true, status: 200, json: async () => ({ token: 'token-2' }) };
      }
      return { ok: true, status: 204 };
    };

    await sendEnvironmentBundle();

    assert.ok(calls.some((u) => u.endsWith('/refresh-token')));
    assert.equal(calls.filter((u) => u.endsWith('/environment-bundle')).length, 2);
  });
});
