import { state } from '../state.js';
import { flushEvents } from '../transport.js';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
const CHECK_INTERVAL_MS = 30000;
const THROTTLE_MS = 1000;

function pushIdleMarker(plugin, extra) {
  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: { plugin, payload: { ...extra } },
  });
}

/**
 * Start idle detection: auto-pause recording after a period of no user
 * interaction and resume on the next interaction.
 * @param {object} collector - The collector API exposing pause()/resume().
 */
export function initIdleWatch(collector) {
  if (typeof window === 'undefined') return;

  state.lastActivity = Date.now();
  let lastWrite = 0;
  let idleStartedAt = null;

  const onActivity = () => {
    // Resume only when the pause was triggered by idle, not by a manual/SSE pause.
    if (state.pausedByIdle && state.isPaused) {
      state.pausedByIdle = false;
      collector.resume();
      // Marker lands AFTER resume so it rides the fresh full snapshot chunk.
      pushIdleMarker('session.idle.end', {
        idleMs: idleStartedAt ? Date.now() - idleStartedAt : null,
      });
      idleStartedAt = null;
    }

    const now = Date.now();
    if (now - lastWrite < THROTTLE_MS) return;
    lastWrite = now;
    state.lastActivity = now;
    try {
      sessionStorage.setItem('voidr_last_activity', now);
    } catch (_) {
      // Ignore sessionStorage errors
    }
  };

  state.idleListeners = ACTIVITY_EVENTS.map((type) => {
    window.addEventListener(type, onActivity, { passive: true, capture: true });
    return { type, handler: onActivity };
  });

  const idleTimeoutMs = (state.config.idleTimeout || 5) * 60 * 1000;

  state.idleInterval = setInterval(() => {
    if (state.isPaused) return;
    if (Date.now() - state.lastActivity > idleTimeoutMs) {
      state.pausedByIdle = true;
      idleStartedAt = Date.now();
      pushIdleMarker('session.idle.start', { lastActivity: state.lastActivity });
      collector.pause();
      // Drain the buffer so idle events aren't stuck client-side until resume.
      flushEvents().catch(() => {});
      console.log('VoidrCollector: Recording paused (idle)');
    }
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop idle detection and remove all activity listeners.
 */
export function stopIdleWatch() {
  if (typeof window === 'undefined') return;

  if (state.idleInterval) {
    clearInterval(state.idleInterval);
    state.idleInterval = null;
  }

  for (const { type, handler } of state.idleListeners) {
    window.removeEventListener(type, handler, { capture: true });
  }
  state.idleListeners = [];
  state.pausedByIdle = false;
}
