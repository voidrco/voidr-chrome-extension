import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { MAX_BODY_SIZE } = await import('../src/constants.js');
const { state, resetState } = await import('../src/state.js');
const { initXhrInterceptor } = await import('../src/network/xhr-interceptor.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createNativeXhr({ onSend, responseText = '', responseHeaders = '' }) {
  return class NativeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.status = 200;
      this.statusText = 'OK';
    }

    open() {}

    setRequestHeader() {}

    send(body) {
      return onSend(this, body);
    }

    addEventListener(type, listener, options = {}) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ listener, once: Boolean(options.once) });
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.set(
        type,
        (this.listeners.get(type) || []).filter((entry) => entry.listener !== listener),
      );
    }

    dispatch(type) {
      const listeners = [...(this.listeners.get(type) || [])];
      this.listeners.set(
        type,
        listeners.filter((entry) => !entry.once),
      );
      listeners.forEach(({ listener }) => listener.call(this, { type, target: this }));
    }

    getAllResponseHeaders() {
      return typeof responseHeaders === 'function' ? responseHeaders() : responseHeaders;
    }

    getResponseHeader(name) {
      if (name.toLowerCase() !== 'content-type') return null;
      const headers = typeof responseHeaders === 'function' ? responseHeaders() : responseHeaders;
      return headers.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || null;
    }

    get responseText() {
      return typeof responseText === 'function' ? responseText() : responseText;
    }
  };
}

beforeEach(() => {
  resetState();
  state.forceStop = false;
  state.isInitialized = true;
  state.sessionId = 'xhr-session';
  state.config = {
    ...state.config,
    collectorUrl: 'https://collector.test',
    networkCapture: true,
  };
});

afterEach(async () => {
  await delay(100);
  state.deactivateXhrInterceptor?.();
  delete globalThis.window;
  resetState();
});

test('dispatches native XHR before bounded FormData capture', async () => {
  let nativeCalled = false;
  let entriesRead = 0;
  const NativeXHR = createNativeXhr({
    onSend(xhr) {
      nativeCalled = true;
      setTimeout(() => xhr.dispatch('loadend'), 0);
      return 'native-result';
    },
    responseText: '{}',
    responseHeaders: 'content-type: application/json\r\n',
  });
  globalThis.window = {
    XMLHttpRequest: NativeXHR,
    location: { origin: 'https://app.test', hostname: 'app.test' },
    performance: { getEntriesByName: () => [] },
  };
  const body = new FormData();
  Array.from({ length: 1000 }, (_, index) => body.append(`field-${index}`, 'x'.repeat(4000)));
  const originalEntries = body.entries.bind(body);
  body.entries = function () {
    const iterator = originalEntries();
    return {
      next() {
        entriesRead += 1;
        assert.equal(nativeCalled, true);
        return iterator.next();
      },
    };
  };

  initXhrInterceptor();
  const xhr = new window.XMLHttpRequest();
  xhr.open('POST', '/api');
  const result = xhr.send(body);

  assert.equal(result, 'native-result');
  assert.equal(nativeCalled, true);
  assert.equal(entriesRead, 0);
  assert.equal(xhr instanceof NativeXHR, true);
  assert.equal(Object.getPrototypeOf(window.XMLHttpRequest), NativeXHR);
  await delay(80);
  assert.equal(entriesRead, 200);
  assert.equal(state.networkBuffer.length, 1);
  assert.match(state.networkBuffer[0].requestBody, /__voidrTruncated/);
});

test('does not process a large response before application loadend listeners', async () => {
  const response = 'x'.repeat(MAX_BODY_SIZE + 1024);
  let responseReads = 0;
  state.isSending = true;
  const NativeXHR = createNativeXhr({
    onSend(xhr) {
      setTimeout(() => xhr.dispatch('loadend'), 0);
    },
    responseText() {
      responseReads += 1;
      return response;
    },
    responseHeaders() {
      responseReads += 1;
      return 'content-type: application/json\r\n';
    },
  });
  globalThis.window = {
    XMLHttpRequest: NativeXHR,
    location: { origin: 'https://app.test', hostname: 'app.test' },
    performance: { getEntriesByName: () => [] },
  };

  initXhrInterceptor();
  const xhr = new window.XMLHttpRequest();
  xhr.open('GET', '/large-response');
  xhr.send();
  await new Promise((resolve) => xhr.addEventListener('loadend', resolve));

  assert.equal(responseReads, 0);
  await delay(80);
  assert.ok(responseReads > 0);
  const captured = [
    ...state.networkBuffer,
    ...state.events
      .filter(({ data }) => data?.plugin === 'network.batch')
      .flatMap(({ data }) => data.payload.requests),
  ];
  assert.equal(captured.length, 1);
  assert.equal(captured[0].responseBody, `${response.slice(0, MAX_BODY_SIZE)}...[TRUNCATED]`);
});
