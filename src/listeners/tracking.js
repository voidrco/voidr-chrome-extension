import { record } from 'rrweb';
import { state } from '../state.js';
import { debounce } from '../utils/helpers.js';

/**
 * Initialize error tracking and UI snapshot heuristics.
 * Captures global errors, unhandled promise rejections,
 * and triggers full snapshots on large DOM mutations.
 */
export function initTracking() {
  // Global errors
  window.addEventListener('error', (e) => {
    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'window.error',
        payload: {
          message: e.message,
          stack: e.error && e.error.stack,
          filename: e.filename,
          position: `${e.lineno}:${e.colno}`,
        },
      },
    });
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (e) => {
    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'promise.rejection',
        payload: {
          reason: e.reason ? e.reason.toString() : 'Unknown error',
        },
      },
    });
  });

  // UI snapshot heuristics — trigger full snapshots on large DOM changes
  try {
    const mutationThreshold = state.config?.uiHeuristics?.mutationThreshold || 50;

    const scheduleSnapshot = debounce(() => {
      record.takeFullSnapshot();
    }, 400);

    const mo = new MutationObserver((mutationList) => {
      let score = 0;
      for (const m of mutationList) {
        score += (m.addedNodes?.length || 0) + (m.removedNodes?.length || 0);
        if (m.type === 'attributes' || m.type === 'characterData') score += 1;
      }
      if (score >= mutationThreshold) {
        scheduleSnapshot();
      }
    });
    mo.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  } catch (_) {
    // noop
  }
}
