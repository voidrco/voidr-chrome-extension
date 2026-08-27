import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

class EventTargetStub {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';
globalThis.window = Object.assign(new EventTargetStub(), {
  location: { hostname: 'app.test' },
  scrollX: 0,
  scrollY: 0,
});
globalThis.document = new EventTargetStub();

const { state, resetState } = await import('../src/state.js');
const { initEventListeners, stopEventListeners } = await import('../src/listeners/events.js');

const target = {
  nodeType: 1,
  id: 'benchmark-button',
  tagName: 'BUTTON',
  textContent: 'Run',
  closest: () => null,
  parentElement: null,
};

const click = () =>
  document.dispatch('click', {
    target,
    composedPath: () => [target],
    clientX: 1,
    clientY: 2,
  });

beforeEach(() => {
  resetState();
  state.forceStop = false;
  state.config.dataMasking.blockSelectors = [];
  stopEventListeners();
});

afterEach(() => {
  stopEventListeners();
  resetState();
});

test('teardown removes handlers and reinitialization does not duplicate them', () => {
  initEventListeners();
  click();
  assert.equal(state.events.length, 1);

  stopEventListeners();
  click();
  assert.equal(state.events.length, 1);

  initEventListeners();
  click();
  assert.equal(state.events.length, 2);
});

test('paused collection ignores semantic DOM events', () => {
  initEventListeners();
  state.isPaused = true;
  click();
  assert.equal(state.events.length, 0);
});
