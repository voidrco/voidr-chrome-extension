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
const {
  initEventListeners,
  readEditableValue,
  replayKeyFromEvent,
  resolveEditableTarget,
  stopEventListeners,
} = await import('../src/listeners/events.js');
const { ElementMapper } = await import('../src/element-mapper.js');

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

test('Verification overlay is excluded from semantic events and the screen map', () => {
  const overlayTarget = {
    ...target,
    id: 'voidr-verification-element',
    closest: (selector) =>
      selector.includes('[data-voidr-verification-overlay]') ? overlayTarget : null,
  };
  initEventListeners();
  document.dispatch('click', {
    target: overlayTarget,
    composedPath: () => [overlayTarget],
    clientX: 1,
    clientY: 2,
  });
  assert.equal(state.events.length, 0);

  const mapper = new ElementMapper();
  assert.equal(mapper._isVisible(overlayTarget), false);
});

test('captures contenteditable text from the composed Shadow DOM origin', () => {
  const host = {
    nodeType: 1,
    id: 'prompt',
    tagName: 'DIV',
    innerText: 'Enviar esta mensagem',
    textContent: 'Enviar esta mensagem',
    isContentEditable: true,
    parentElement: null,
    closest: (selector) => (selector.includes('[contenteditable') ? host : null),
    querySelector: () => null,
  };
  const shadowHost = {
    nodeType: 1,
    tagName: 'VOIDR-EDITOR',
    closest: () => null,
  };

  initEventListeners();
  document.dispatch('input', {
    target: shadowHost,
    composedPath: () => [host, shadowHost],
  });
  document.dispatch('keydown', {
    target: shadowHost,
    composedPath: () => [host, shadowHost],
    key: 'Enter',
  });

  assert.equal(state.events[0].data.payload.selector, 'div#prompt');
  assert.equal(state.events[0].data.payload.value, 'Enviar esta mensagem');
  assert.equal(state.events[1].data.payload.key, 'Enter');
});

test('masks coarse privacy levels and blocked contenteditable descendants', () => {
  const host = {
    nodeType: 1,
    id: 'private-prompt',
    tagName: 'DIV',
    innerText: 'conteúdo privado',
    textContent: 'conteúdo privado',
    isContentEditable: true,
    parentElement: null,
    closest: (selector) => (selector.includes('[contenteditable') ? host : null),
    querySelector: () => ({ dataset: { sensitivity: 'block' } }),
  };
  state.config.privacyLevel = 'mask-user-input';

  initEventListeners();
  document.dispatch('input', { target: host, composedPath: () => [host] });

  assert.equal(state.events[0].data.payload.value, '***');
});

test('normalizes editable targets and records only replayable action keys', () => {
  const host = {
    tagName: 'DIV',
    innerText: 'texto rico',
    isContentEditable: true,
    closest: () => null,
  };
  const child = {
    tagName: 'SPAN',
    closest: (selector) => (selector.includes('[contenteditable') ? host : null),
  };

  assert.equal(resolveEditableTarget(child), host);
  assert.equal(readEditableValue(host), 'texto rico');
  assert.equal(replayKeyFromEvent({ key: 'a' }), null);
  assert.equal(replayKeyFromEvent({ key: 'Enter', repeat: true }), null);
  assert.equal(replayKeyFromEvent({ key: 'Tab', ctrlKey: true }), 'Control+Tab');
  assert.equal(replayKeyFromEvent({ key: 'Escape' }), 'Escape');
});
