import { state } from '../state.js';
import { isTasy, TASY_MASK_SELECTORS } from '../constants.js';
import {
  generateSelector,
  getTextContent,
  throttle,
  truncate,
} from '../utils/helpers.js';
import {
  resolveInteractiveTarget,
  getAccessibleLabel,
} from '../utils/interactive-element.js';

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

    if (state.elementMapper) state.elementMapper.onInteraction(target, 'input');
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

    if (state.elementMapper) state.elementMapper.onInteraction(target, 'change');
  });

  // Click events — CAPTURE phase: runs before the app's own handlers (and any
  // history.pushState they trigger), so a navigation click is recorded on the
  // ORIGIN page, before the page.view event. We never stop propagation or
  // preventDefault, so the host app is unaffected.
  document.addEventListener(
    'click',
    (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const rawTarget = path[0] || e.target;
      if (!rawTarget || !rawTarget.tagName) return;
      // The deepest node is usually an icon's <svg>/<path> with no text and a
      // positional selector — resolve the interactive ancestor (a/button/...)
      // so text/selector/interaction describe the real control.
      const target = resolveInteractiveTarget(path) || rawTarget;
      if (shouldIgnore(target) || shouldIgnore(rawTarget)) return;

      const label = getAccessibleLabel(target) || getTextContent(target);
      const href =
        typeof target.getAttribute === 'function' ? target.getAttribute('href') : null;
      const role =
        typeof target.getAttribute === 'function' ? target.getAttribute('role') : null;

      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'user.click',
          payload: {
            selector: generateSelector(target),
            tag: target.tagName,
            text: isTasyMasked(target) ? '***' : truncate(label, 100),
            ...(href ? { href } : {}),
            ...(role ? { role } : {}),
            position: {
              x: e.clientX,
              y: e.clientY,
            },
          },
        },
      });

      if (state.elementMapper) state.elementMapper.onInteraction(target, 'click');
    },
    { capture: true },
  );

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
