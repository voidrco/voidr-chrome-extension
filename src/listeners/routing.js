import { record } from 'rrweb';
import { state } from '../state.js';

/**
 * Capture SPA route changes via pushState, replaceState, popstate, and hashchange.
 */
export function initRoutingCapture() {
  try {
    state.lastHref = typeof window !== 'undefined' && window.location ? window.location.href : null;

    // Capture the initial page after a short delay (so the title is loaded)
    const captureInitialPage = () => {
      try {
        const title = document.title || '';
        const url = window.location.href;
        state.events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'page.view',
            payload: {
              url,
              title,
              trigger: 'initial',
            },
          },
        });
      } catch (_) { }
    };

    setTimeout(captureInitialPage, 100);

    const onRouteChange = (trigger) => {
      const current = window.location.href;
      if (!current || current === state.lastHref) return;
      const from = state.lastHref;
      state.lastHref = current;

      // Capture the page title with a small delay (SPAs may update the title asynchronously)
      setTimeout(() => {
        const title = document.title || '';
        state.events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'page.view',
            payload: {
              url: current,
              title,
              from,
              trigger,
            },
          },
        });
      }, 50);

      // Custom rrweb event to indicate route change
      try {
        if (typeof record?.addCustomEvent === 'function') {
          record.addCustomEvent('route', { from, to: current, trigger });
        }
      } catch (_) { }

      // Force a full snapshot to ensure the player reflects the new UI
      try {
        if (typeof record?.takeFullSnapshot === 'function') {
          record.takeFullSnapshot();
        }
      } catch (_) { }
    };

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function () {
      const result = origPushState.apply(this, arguments);
      onRouteChange('pushState');
      return result;
    };

    history.replaceState = function () {
      const result = origReplaceState.apply(this, arguments);
      onRouteChange('replaceState');
      return result;
    };

    window.addEventListener('popstate', () => onRouteChange('popstate'));
    window.addEventListener('hashchange', () => onRouteChange('hashchange'));
  } catch (err) {
    // noop
  }
}
