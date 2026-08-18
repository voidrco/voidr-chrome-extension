import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { state, resetState } = await import('../src/state.js');
const { initFetchInterceptor } = await import('../src/network/fetch-interceptor.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetState();
  state.forceStop = false;
  state.isInitialized = true;
  state.sessionId = 'fetch-session';
  state.config = {
    ...state.config,
    collectorUrl: 'https://collector.test',
    networkCapture: true,
  };
});

afterEach(async () => {
  await delay(150);
  delete globalThis.window;
  resetState();
});

test('dispatches native fetch before a streamed request body is captured', async () => {
  let nativeCalled = false;
  globalThis.window = {
    location: { origin: 'https://app.test', hostname: 'app.test' },
    performance: { getEntriesByName: () => [] },
    fetch: async (input) => {
      nativeCalled = true;
      await input.text();
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };

  initFetchInterceptor();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (let index = 0; index < 5; index += 1) {
        await delay(20);
        controller.enqueue(encoder.encode(`chunk-${index}`));
      }
      controller.close();
    },
  });
  const request = new Request('https://app.test/api', {
    method: 'POST',
    body,
    duplex: 'half',
  });

  const responsePromise = window.fetch(request);
  await delay(5);

  assert.equal(nativeCalled, true);
  assert.equal((await responsePromise).status, 200);
  await delay(160);
  assert.equal(state.networkBuffer.length, 1);
  assert.equal(state.networkBuffer[0].requestBody, 'chunk-0chunk-1chunk-2chunk-3chunk-4');
});
