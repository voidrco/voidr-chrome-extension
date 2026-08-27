import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const {
  LIVE_CONTEXT_VERSION,
  recordLiveContext,
  sanitizeLiveUrl,
  snapshotLiveContext,
  updateLiveContext,
} = await import('../src/live-context.js');
const { resetState, state } = await import('../src/state.js');

beforeEach(() => {
  resetState();
  state.sessionStartedAt = 1_000;
  state.sessionId = 'session-live-context';
});

describe('live evidence context', () => {
  test('sanitizes secrets before exposing a request preview', () => {
    recordLiveContext(
      'requests',
      {
        requestId: 'request-1',
        timestamp: 1_500,
        method: 'POST',
        url: 'https://app.test/pay?order=42&token=secret-token',
        status: 201,
        duration: 38,
        requestHeaders: {
          authorization: 'Bearer secret-token',
          'x-request-id': 'trace-safe',
        },
        requestBody: JSON.stringify({ order: 42, password: 'hidden', nested: { apiKey: 'x' } }),
        responseBody: JSON.stringify({ ok: true, sessionToken: 'hidden' }),
      },
      { id: 'request-1', timestamp: 1_500 },
    );

    const snapshot = snapshotLiveContext({ category: 'requests' });
    const [request] = snapshot.categories.requests;
    assert.equal(snapshot.version, LIVE_CONTEXT_VERSION);
    assert.equal(request.id, 'request-1');
    assert.equal(request.offsetMs, 500);
    assert.match(request.url, /order=42/);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-token|hidden/);
    assert.equal(request.requestHeaders.authorization, '[REDACTED]');
    assert.equal(request.requestHeaders['x-request-id'], 'trace-safe');
    assert.equal(request.requestBodyPreview.password, '[REDACTED]');
    assert.equal(request.requestBodyPreview.nested.apiKey, '[REDACTED]');
    assert.equal(request.responseBodyPreview.sessionToken, '[REDACTED]');
  });

  test('links requests to the current page and the causally-nearest click', () => {
    const page = recordLiveContext(
      'pages',
      { url: 'https://app.test/cart', title: 'Cart', trigger: 'initial' },
      { timestamp: 1_100 },
    );
    recordLiveContext(
      'clicks',
      { clickId: 'click-1', text: 'Checkout', tag: 'BUTTON' },
      { id: 'click-1', timestamp: 1_200 },
    );
    recordLiveContext(
      'requests',
      { requestId: 'request-1', url: 'https://app.test/api/checkout', method: 'POST' },
      { id: 'request-1', timestamp: 1_250 },
    );
    updateLiveContext('clicks', 'click-1', {
      effects: { networkMs: 50, mutationMs: 90 },
    });

    const snapshot = snapshotLiveContext({ limit: 10 });
    assert.equal(snapshot.categories.requests[0].pageRef, page.id);
    assert.equal(snapshot.categories.requests[0].clickRef, 'click-1');
    assert.deepEqual(snapshot.categories.clicks[0].effects, {
      networkMs: 50,
      mutationMs: 90,
    });
  });

  test('bounds ring storage and each read', () => {
    for (let index = 0; index < 120; index += 1) {
      recordLiveContext(
        'errors',
        { plugin: 'window.error', message: `Failure ${index}` },
        { timestamp: 2_000 + index },
      );
    }
    const snapshot = snapshotLiveContext({ category: 'errors', limit: 500 });
    assert.equal(snapshot.counts.errors, 120);
    assert.equal(state.liveContext.categories.errors.length, 100);
    assert.equal(snapshot.categories.errors.length, 50);
    assert.equal(snapshot.categories.errors[0].message, 'Failure 119');
  });

  test('returns detached snapshots and bounds structured body previews', () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, 'x'.repeat(300)]),
    );
    recordLiveContext(
      'requests',
      { requestId: 'request-detached', url: 'https://app.test/api', responseBody: oversized },
      { id: 'request-detached', timestamp: 3_000 },
    );
    const first = snapshotLiveContext({ category: 'requests' });
    assert.equal(typeof first.categories.requests[0].responseBodyPreview, 'string');
    assert.ok(first.categories.requests[0].responseBodyPreview.length <= 2001);
    first.categories.requests[0].url = 'https://mutated.invalid';
    const second = snapshotLiveContext({ category: 'requests' });
    assert.equal(second.categories.requests[0].url, 'https://app.test/api');
  });

  test('sanitizes URL credentials and sensitive query values', () => {
    const url = sanitizeLiveUrl(
      'https://user:pass@app.test/path?filter=active&api_key=unsafe&session=unsafe',
    );
    assert.doesNotMatch(url, /user|pass|unsafe/);
    assert.match(url, /filter=active/);
  });
});
