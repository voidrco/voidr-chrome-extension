import { state } from '../state.js';

const MAX_LONG_TASKS_PER_SESSION = 300;

/**
 * Capture main-thread blocking via the Long Animation Frames API when
 * available (richer attribution), falling back to the Long Task API.
 * Entries below the configured threshold are dropped to limit noise.
 */
export function initLongTasks() {
  if (state.config.captureLongTasks === false) return;
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;

  const thresholdMs = state.config.longTaskThresholdMs || 100;
  let count = 0;

  const push = (payload) => {
    if (state.forceStop || state.isPaused || !state.isInitialized) return;
    if (count >= MAX_LONG_TASKS_PER_SESSION) return;
    count += 1;
    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: { plugin: 'perf.longtask', payload },
    });
  };

  const supported = PerformanceObserver.supportedEntryTypes || [];

  if (supported.includes('long-animation-frame')) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < thresholdMs) continue;
          const script = entry.scripts && entry.scripts[0];
          push({
            source: 'loaf',
            duration: Math.round(entry.duration),
            blockingDuration: Math.round(entry.blockingDuration || 0),
            scriptUrl: script?.sourceURL ? String(script.sourceURL).slice(0, 500) : null,
            scriptFunction: script?.sourceFunctionName
              ? String(script.sourceFunctionName).slice(0, 200)
              : null,
          });
        }
      });
      observer.observe({ type: 'long-animation-frame', buffered: true });
      state.longTaskObserver = observer;
      return;
    } catch {
      /* fall through to longtask */
    }
  }

  if (supported.includes('longtask')) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < thresholdMs) continue;
          const attribution = entry.attribution && entry.attribution[0];
          push({
            source: 'longtask',
            duration: Math.round(entry.duration),
            containerType: attribution?.containerType || null,
            containerName: attribution?.containerName
              ? String(attribution.containerName).slice(0, 200)
              : null,
          });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
      state.longTaskObserver = observer;
    } catch {
      /* noop */
    }
  }
}

export function stopLongTasks() {
  if (state.longTaskObserver) {
    try {
      state.longTaskObserver.disconnect();
    } catch {
      /* noop */
    }
    state.longTaskObserver = null;
  }
}
