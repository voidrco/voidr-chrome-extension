import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { attachUnloadLifecycleHandlers } = await import('../src/collector.js');

class WindowStub {
  constructor() {
    this.listeners = new Map();
    this.frames = new Map();
    this.nextFrameId = 1;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) || []) handler();
  }

  requestAnimationFrame(handler) {
    const id = this.nextFrameId;
    this.nextFrameId += 1;
    this.frames.set(id, handler);
    return id;
  }

  cancelAnimationFrame(id) {
    this.frames.delete(id);
  }

  renderFrame() {
    const frames = [...this.frames.values()];
    this.frames.clear();
    for (const frame of frames) frame();
  }
}

let target;
let lifecycle;
let unloadCount;

beforeEach(() => {
  target = new WindowStub();
  unloadCount = 0;
  lifecycle = attachUnloadLifecycleHandlers({
    target,
    onUnload: () => {
      unloadCount += 1;
    },
  });
});

afterEach(() => lifecycle.dispose());

test('deduplicates beforeunload and pagehide from the same unload', () => {
  target.dispatch('beforeunload');
  target.dispatch('pagehide');

  assert.equal(unloadCount, 1);
});

test('re-arms after a cancelled unload renders another frame', () => {
  target.dispatch('beforeunload');
  target.renderFrame();
  target.dispatch('beforeunload');
  target.dispatch('pagehide');

  assert.equal(unloadCount, 2);
});

test('re-arms after a page is restored from the back-forward cache', () => {
  target.dispatch('pagehide');
  target.dispatch('pageshow');
  target.dispatch('pagehide');

  assert.equal(unloadCount, 2);
});
