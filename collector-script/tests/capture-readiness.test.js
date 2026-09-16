import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { createCollector } = await import('../src/collector.js');
const { state, resetState } = await import('../src/state.js');

afterEach(() => resetState());

test('forced session ID alone does not make Capture ready', () => {
  resetState();
  const collector = createCollector();
  state.isInitialized = true;
  state.forceStop = false;
  state.sessionId = 'forced-session';
  assert.equal(collector.isCaptureReady(), false);

  state.authToken = 'token';
  assert.equal(collector.isCaptureReady(), false);
  state.captureReady = true;
  assert.equal(collector.isCaptureReady(), true);

  state.forceStop = true;
  assert.equal(collector.isCaptureReady(), false);
});
