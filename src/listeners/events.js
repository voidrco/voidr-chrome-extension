import { state } from '../state.js';
import { isTasy, TASY_MASK_SELECTORS } from '../constants.js';
import { generateSelector, getTextContent, throttle, truncate } from '../utils/helpers.js';

const TASY_MASK_SELECTOR = TASY_MASK_SELECTORS.join(', ');

let installed = false;
let listeners = [];

function shouldIgnore(element) {
  if (!element?.closest) return false;
  const selectors = [
    '[data-sensitivity="block"]',
    ...(state.config.dataMasking.blockSelectors || []),
  ].join(',');
  return Boolean(element.closest(selectors));
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
  element?.type === 'password' ||
  element?.autocomplete === 'current-password' ||
  element?.autocomplete === 'new-password';

function addListener(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  listeners.push({ target, type, handler, options });
}

function pushInputEvent(event, plugin) {
  if (state.isPaused || shouldIgnore(event.target)) return;
  const target = event.target;
  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin,
      payload: {
        selector: generateSelector(target),
        tag: target.tagName,
        value: isMaskedInput(target) ? '***' : truncate(target.value, 100),
        type: target.type,
      },
    },
  });
  state.elementMapper?.onInteraction(target, plugin === 'user.input' ? 'input' : 'change');
}

function pushClickEvent(event) {
  if (state.isPaused) return;
  const target = event.composedPath?.()[0] || event.target;
  if (shouldIgnore(target)) return;
  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin: 'user.click',
      payload: {
        selector: event.__voidrSelector || generateSelector(target),
        tag: target.tagName,
        text: isTasyMasked(target) ? '***' : getTextContent(target),
        clickId: event.__voidrClickId || null,
        position: { x: event.clientX, y: event.clientY },
      },
    },
  });
  state.elementMapper?.onInteraction(target, 'click');
}

export function initEventListeners() {
  if (installed) return;
  installed = true;
  addListener(document, 'input', (event) => pushInputEvent(event, 'user.input'));
  addListener(document, 'change', (event) => pushInputEvent(event, 'user.change'));
  addListener(document, 'click', pushClickEvent);
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
