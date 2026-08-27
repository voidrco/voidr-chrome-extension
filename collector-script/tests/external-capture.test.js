import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { createCollector } = await import('../src/collector.js');
const { sanitizeExternalNetworkEvent } = await import('../src/network/external-capture.js');
const { resetState, state } = await import('../src/state.js');

describe('trusted-host network capture', () => {
  beforeEach(() => {
    resetState();
    state.forceStop = false;
    state.isInitialized = true;
    state.isPaused = false;
  });

  afterEach(resetState);

  it('strips URL secrets and drops fields outside the canonical projection', () => {
    const event = sanitizeExternalNetworkEvent(
      {
        type: 'fetchError',
        requestId: 'desktop:12.4:0',
        timestamp: 1_699_999_999_250,
        url: 'https://admin:secret@api.test/customers/12345678/orders/550e8400-e29b-41d4-a716-446655440000?token=super-secret#customer',
        method: 'post',
        status: 500,
        statusText: 'Internal Server Error',
        durationMs: 124.8,
        contentType: 'application/json; charset=utf-8',
        responseSize: 512,
        headers: { authorization: 'Bearer secret' },
        requestBody: '{"password":"secret"}',
        responseBody: '{"token":"secret"}',
      },
      1_700_000_000_000,
    );

    assert.deepEqual(event, {
      type: 'fetchError',
      requestId: 'desktop:12.4:0',
      timestamp: 1_699_999_999_250,
      url: 'https://api.test/customers/:id/orders/:id',
      method: 'POST',
      status: 500,
      statusText: 'Internal Server Error',
      duration: 125,
      contentType: 'application/json',
      responseSize: 512,
      requestSize: 0,
    });
  });

  it('redacts personal data and opaque tokens embedded in path segments', () => {
    const event = sanitizeExternalNetworkEvent({
      url: 'https://api.test/users/joao%40example.com/reset/eyJhbGciOiJIUzI1NiJ9abcdefgh',
      status: 500,
    });

    assert.equal(event.url, 'https://api.test/users/:id/reset/:id');
    assert.equal(event.url.includes('joao'), false);
    assert.equal(event.url.includes('eyJ'), false);

    const namedCustomer = sanitizeExternalNetworkEvent({
      url: 'https://api.test/clientes/joao-da-silva/credito',
      status: 500,
    });
    assert.equal(namedCustomer.url, 'https://api.test/clientes/:id/credito');
    assert.equal(namedCustomer.url.includes('joao'), false);
  });

  it('rejects invalid protocols and clamps attacker-controlled values', () => {
    assert.equal(sanitizeExternalNetworkEvent({ url: 'file:///etc/passwd' }), null);
    assert.equal(sanitizeExternalNetworkEvent({ url: 'not-a-url' }), null);

    const event = sanitizeExternalNetworkEvent(
      {
        url: 'https://api.test/health',
        type: 'unknown',
        method: 'GET\r\nX-Injected',
        status: 999,
        duration: -10,
        responseSize: Number.POSITIVE_INFINITY,
      },
      1_700_000_000_000,
    );
    assert.equal(event.type, 'resource');
    assert.equal(event.method, 'GET');
    assert.equal(event.status, 599);
    assert.equal(event.duration, 0);
    assert.equal(event.responseSize, 0);
  });

  it('enters the existing network.batch buffer only while recording', () => {
    const collector = createCollector();
    const accepted = collector.captureNetwork({
      type: 'xhr',
      requestId: 'desktop-1',
      timestamp: Date.now() - 20,
      url: 'https://api.test/orders?session=secret',
      method: 'GET',
      status: 201,
      duration: 20,
    });

    assert.equal(accepted, true);
    assert.equal(state.networkBuffer.length, 1);
    assert.equal(state.networkBuffer[0].url, 'https://api.test/orders');
    assert.equal(state.networkBuffer[0].status, 201);
    assert.equal('headers' in state.networkBuffer[0], false);
    assert.equal('requestBody' in state.networkBuffer[0], false);

    state.isPaused = true;
    assert.equal(collector.captureNetwork({ url: 'https://api.test/paused' }), false);
    assert.equal(state.networkBuffer.length, 1);

    state.isPaused = false;
    state.config.networkCapture = false;
    assert.equal(collector.captureNetwork({ url: 'https://api.test/disabled' }), false);
    assert.equal(state.networkBuffer.length, 1);
  });

  it('promotes a host failure before an immediate explicit Stop can miss the network buffer', () => {
    const collector = createCollector();
    const accepted = collector.captureNetwork({
      type: 'fetch',
      requestId: 'desktop-500',
      timestamp: Date.now() - 20,
      url: 'https://api.test/orders/12345678?token=secret',
      method: 'GET',
      status: 500,
      duration: 20,
    });

    assert.equal(accepted, true);
    assert.equal(state.networkBuffer.length, 0);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].data.plugin, 'network.batch');
    assert.equal(state.events[0].data.payload.requests.length, 1);
    assert.equal(state.events[0].data.payload.requests[0].status, 500);
    assert.equal(state.events[0].data.payload.requests[0].url, 'https://api.test/orders/:id');
  });
});
