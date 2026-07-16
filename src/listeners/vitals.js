import { onLCP, onCLS, onINP, onTTFB, onFCP } from 'web-vitals';
import { state } from '../state.js';

let installed = false;

/**
 * Capture Core Web Vitals (LCP, CLS, INP, TTFB, FCP) via the web-vitals
 * library. Each metric is pushed as a `web.vital` plugin event when finalized
 * (web-vitals reports CLS/INP/LCP on visibility hidden, so the unload flush
 * path carries them out).
 */
export function initVitals() {
  if (installed) return;
  if (state.config.captureWebVitals === false) return;
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  installed = true;

  const report = (metric) => {
    if (
      state.forceStop ||
      state.isPaused ||
      !state.isInitialized ||
      state.config.captureWebVitals === false
    )
      return;
    try {
      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'web.vital',
          payload: {
            name: metric.name,
            value: Math.round(metric.value * 1000) / 1000,
            rating: metric.rating,
            delta: Math.round(metric.delta * 1000) / 1000,
            id: metric.id,
            navigationType: metric.navigationType,
            url: window.location.href.slice(0, 2000),
          },
        },
      });
    } catch {
      /* noop */
    }
  };

  try {
    onLCP(report);
    onCLS(report);
    onINP(report);
    onTTFB(report);
    onFCP(report);
  } catch {
    /* unsupported browser — vitals silently skipped */
  }
}
