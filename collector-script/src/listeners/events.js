import { state } from '../state.js';
import { isTasy, TASY_MASK_SELECTORS, VERIFICATION_OVERLAY_SELECTOR } from '../constants.js';
import { generateSelector, getTextContent, throttle, truncate } from '../utils/helpers.js';
import {
  getAccessibleLabel,
  isElementVisible,
  isRecorderUi,
  resolveInteractiveTarget,
} from '../utils/interactive-element.js';
import { recordLiveContext } from '../live-context.js';

const TASY_MASK_SELECTOR = TASY_MASK_SELECTORS.join(', ');

let installed = false;
let listeners = [];

function blockSelector() {
  return [
    '[data-sensitivity="block"]',
    VERIFICATION_OVERLAY_SELECTOR,
    ...(state.config.dataMasking.blockSelectors || []),
  ].join(',');
}

function shouldIgnore(element) {
  if (!element?.closest) return false;
  try {
    return Boolean(element.closest(blockSelector()));
  } catch {
    return false;
  }
}

function containsBlockedContent(element) {
  if (!element?.querySelector) return false;
  try {
    return Boolean(element.querySelector(blockSelector()));
  } catch {
    return false;
  }
}

function eventOrigin(event) {
  const origin = event?.composedPath?.()[0] ?? event?.target;
  return origin?.nodeType === 1 ? origin : (origin?.parentElement ?? event?.target);
}

function isTasyMasked(element) {
  if (!isTasy || !element) return false;
  try {
    return element.matches(TASY_MASK_SELECTOR) || Boolean(element.closest(TASY_MASK_SELECTOR));
  } catch {
    return false;
  }
}

const isMaskedInput = (element) =>
  isTasyMasked(element) ||
  state.config.dataMasking.inputs === true ||
  state.config.privacyLevel === 'mask' ||
  state.config.privacyLevel === 'mask-user-input' ||
  containsBlockedContent(element) ||
  element?.type === 'password' ||
  element?.autocomplete === 'current-password' ||
  element?.autocomplete === 'new-password';

const FORM_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const REPLAYABLE_KEYS = new Set(['Enter', 'Tab', 'Escape']);

export function resolveEditableTarget(element) {
  if (!element || typeof element !== 'object') return element;
  if (FORM_CONTROL_TAGS.has(element.tagName)) return element;
  try {
    return (
      element.closest?.(
        '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
      ) || element
    );
  } catch {
    return element;
  }
}

export function readEditableValue(element) {
  if (FORM_CONTROL_TAGS.has(element?.tagName)) {
    return typeof element.value === 'string' ? element.value : '';
  }
  if (element?.isContentEditable) {
    return element.innerText ?? element.textContent ?? '';
  }
  if (element?.value !== undefined) return element.value;
  return '';
}

export function replayKeyFromEvent(event) {
  if (
    !event ||
    event.repeat ||
    event.isComposing ||
    event.keyCode === 229 ||
    !REPLAYABLE_KEYS.has(event.key)
  ) {
    return null;
  }
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.metaKey) modifiers.push('Meta');
  if (event.shiftKey) modifiers.push('Shift');
  modifiers.push(event.key);
  return modifiers.join('+');
}

function addListener(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  listeners.push({ target, type, handler, options });
}

function pushInputEvent(event, plugin) {
  const target = resolveEditableTarget(eventOrigin(event));
  if (state.isPaused || shouldIgnore(target)) return;
  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin,
      payload: {
        selector: generateSelector(target),
        tag: target.tagName,
        value: isMaskedInput(target) ? '***' : truncate(readEditableValue(target), 100),
        type: target.type,
      },
    },
  });
  state.elementMapper?.onInteraction(target, plugin === 'user.input' ? 'input' : 'change');
}

function pushPressEvent(event) {
  const key = replayKeyFromEvent(event);
  if (state.isPaused || !key) return;
  const target = resolveEditableTarget(eventOrigin(event));
  if (!target || shouldIgnore(target)) return;
  const tag = target.tagName;
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true;
  if (!editable) return;

  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin: 'user.press',
      payload: {
        selector: generateSelector(target),
        tag,
        key,
      },
    },
  });
}

function pushClickEvent(event) {
  if (state.isPaused) return;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const rawTarget = path[0] || event.target;
  if (!rawTarget?.tagName) return;
  const target = resolveInteractiveTarget(path) || rawTarget;
  if (shouldIgnore(target) || shouldIgnore(rawTarget)) return;
  if (isRecorderUi(target)) return;
  // A UI that forwards the click to a hidden native control (Azure B2C behind a
  // custom design system) re-dispatches it there, so the recording ends up with
  // the invisible element the test can never act on. The visible click is
  // already recorded milliseconds earlier — dropping this one keeps it, and
  // keeps the effects attributed to it.
  if (!isElementVisible(target)) return;

  const label = getAccessibleLabel(target) || getTextContent(target);
  const href = typeof target.getAttribute === 'function' ? target.getAttribute('href') : null;
  const role = typeof target.getAttribute === 'function' ? target.getAttribute('role') : null;

  const timestamp = Date.now();
  const payload = {
    selector: generateSelector(target),
    tag: target.tagName,
    text: isTasyMasked(target) ? '***' : truncate(label, 100),
    ...(href ? { href } : {}),
    ...(role ? { role } : {}),
    clickId: event.__voidrClickId || null,
    position: { x: event.clientX, y: event.clientY },
  };
  state.events.push({
    type: 5,
    timestamp,
    data: {
      plugin: 'user.click',
      payload,
    },
  });
  recordLiveContext('clicks', payload, {
    id: payload.clickId || undefined,
    timestamp,
  });
  state.elementMapper?.onInteraction(target, 'click');
}

export function initEventListeners() {
  if (installed) return;
  installed = true;
  addListener(document, 'input', (event) => pushInputEvent(event, 'user.input'));
  addListener(document, 'change', (event) => pushInputEvent(event, 'user.change'));
  addListener(document, 'keydown', pushPressEvent, { capture: true });
  addListener(document, 'click', pushClickEvent, { capture: true });
  addListener(
    window,
    'scroll',
    throttle(() => {
      if (state.isPaused) return;
      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: { plugin: 'user.scroll', payload: { x: window.scrollX, y: window.scrollY } },
      });
    }, 200),
  );
}

export function stopEventListeners() {
  if (!installed) return;
  for (const { target, type, handler, options } of listeners) {
    target.removeEventListener(type, handler, options);
  }
  installed = false;
  listeners = [];
}
