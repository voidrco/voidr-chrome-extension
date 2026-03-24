import { state } from '../state.js';
import { isTasy, TASY_MASK_SELECTORS } from '../constants.js';
import {
  generateSelector,
  getTextContent,
  throttle,
  truncate,
} from '../utils/helpers.js';

/**
 * Check if an element matches any block selector (should be ignored for capture).
 */
function shouldIgnore(el) {
  if (!el.closest) return false;
  const selectors = [
    '[data-sensitivity="block"]',
    ...(state.config.dataMasking.blockSelectors || []),
  ].join(',');
  return el.closest(selectors);
}

/**
 * Initialize DOM event listeners for input, change, click, and scroll events.
 */
export function initEventListeners() {
  // HOTFIX: helper to check if element matches TASY mask selectors (remove with hotfix)
  const isTasyMasked = (el) => {
    if (!isTasy || !el) return false;
    const sel = TASY_MASK_SELECTORS.join(', ');
    try { return el.matches(sel) || !!el.closest(sel); } catch { return false; }
  };

  // Input events
  document.addEventListener('input', (e) => {
    const target = e.target;
    if (shouldIgnore(target)) return;

    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'user.input',
        payload: {
          selector: generateSelector(target),
          tag: target.tagName,
          value: isTasyMasked(target) ? '***' : truncate(target.value, 100),
          type: target.type,
        },
      },
    });
  });

  // Change events
  document.addEventListener('change', (e) => {
    const target = e.target;
    if (shouldIgnore(target)) return;

    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'user.change',
        payload: {
          selector: generateSelector(target),
          tag: target.tagName,
          value: isTasyMasked(target) ? '***' : truncate(target.value, 100),
          type: target.type,
        },
      },
    });
  });

  // Click events
  document.addEventListener('click', (e) => {
    const target = e.composedPath()[0];
    if (shouldIgnore(target)) return;

    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'user.click',
        payload: {
          selector: generateSelector(target),
          tag: target.tagName,
          text: isTasyMasked(target) ? '***' : getTextContent(target),
          position: {
            x: e.clientX,
            y: e.clientY,
          },
        },
      },
    });
  });

  // Scroll events (throttled)
  const scrollHandler = throttle(() => {
    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'user.scroll',
        payload: {
          x: window.scrollX,
          y: window.scrollY,
        },
      },
    });
  }, 200);

  window.addEventListener('scroll', scrollHandler);
}
