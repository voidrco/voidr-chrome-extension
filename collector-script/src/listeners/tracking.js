import { record } from 'rrweb';
import { state } from '../state.js';
import { truncate } from '../utils/helpers.js';
import { notifyBufferTrigger } from '../buffer-mode.js';
import { recordLiveContext } from '../live-context.js';

const MAX_ERRORS_PER_SESSION = 500;
const REPEAT_REPORT_EVERY = 10;

// hash → occurrence count; identical errors are reported once and then
// counted (web-see-style dedup) instead of flooding the payload.
const seenErrors = new Map();
let errorCount = 0;
let installed = false;
let listeners = [];
let snapshotTimer = null;

function addListener(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  listeners.push({ target, type, handler, options });
}

function hashError(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function pushError(plugin, payload, dedupKey) {
  if (errorCount >= MAX_ERRORS_PER_SESSION) return;

  const hash = hashError(dedupKey);
  const entry = seenErrors.get(hash);
  if (entry) {
    entry.count += 1;
    recordLiveContext('errors', { plugin, ...payload, hash, occurrence: entry.count });
    if (entry.count % REPEAT_REPORT_EVERY === 0) {
      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'error.repeat',
          payload: { hash, count: entry.count },
        },
      });
    }
    return;
  }

  seenErrors.set(hash, { count: 1 });
  errorCount += 1;
  recordLiveContext('errors', { plugin, ...payload, hash, occurrence: 1 });
  state.events.push({
    type: 5,
    timestamp: Date.now(),
    data: {
      plugin,
      payload: { ...payload, hash },
    },
  });
}

function serializeReason(reason) {
  if (reason instanceof Error) {
    return {
      reason: reason.message || String(reason),
      name: reason.name || 'Error',
      stack: typeof reason.stack === 'string' ? truncate(reason.stack, 8000) : null,
    };
  }
  if (reason && typeof reason === 'object') {
    try {
      return { reason: truncate(JSON.stringify(reason), 2000), name: null, stack: null };
    } catch {
      return { reason: String(reason), name: null, stack: null };
    }
  }
  return { reason: reason != null ? String(reason) : 'Unknown error', name: null, stack: null };
}

/**
 * Manual error capture (VoidrCollector.captureException). Feeds the same
 * dedup pipeline as automatic errors.
 */
export function captureManualError(error, context = {}) {
  const serialized = serializeReason(error);
  let contextStr = null;
  if (context && typeof context === 'object') {
    try {
      contextStr = truncate(JSON.stringify(context), 2000);
    } catch {
      contextStr = null;
    }
  }
  pushError(
    'manual.error',
    {
      message: serialized.reason,
      name: serialized.name,
      stack: serialized.stack,
      context: contextStr,
    },
    `manual|${serialized.name || ''}|${serialized.reason}`,
  );
  notifyBufferTrigger('manual-error');
}

function resourceDescriptor(target) {
  const tag = (target.tagName || '').toLowerCase();
  const url = target.src || target.href || '';
  return { tag, url: typeof url === 'string' ? url.slice(0, 2000) : '' };
}

/**
 * Initialize error tracking and UI snapshot heuristics.
 * Captures global JS errors, resource load errors, unhandled promise
 * rejections, CSP violations, and triggers full snapshots on large DOM
 * mutations.
 */
export function initTracking() {
  if (installed) return;
  installed = true;
  // Global errors + resource load errors (capture phase: resource error
  // events don't bubble)
  addListener(
    window,
    'error',
    (e) => {
      if (state.isPaused) return;
      const target = e.target;
      const isResourceError =
        target &&
        target !== window &&
        (target.tagName === 'IMG' ||
          target.tagName === 'SCRIPT' ||
          target.tagName === 'LINK' ||
          target.tagName === 'AUDIO' ||
          target.tagName === 'VIDEO' ||
          target.tagName === 'SOURCE' ||
          target.tagName === 'IFRAME');

      if (isResourceError) {
        if (state.config.captureResourceErrors === false) return;
        const { tag, url } = resourceDescriptor(target);
        if (!url) return;
        pushError('resource.error', { tag, url }, `resource|${tag}|${url}`);
        return;
      }

      pushError(
        'window.error',
        {
          message: e.message,
          stack:
            e.error && typeof e.error.stack === 'string' ? truncate(e.error.stack, 8000) : null,
          filename: e.filename,
          position: `${e.lineno}:${e.colno}`,
        },
        `error|${e.message}|${e.filename}|${e.lineno}:${e.colno}`,
      );
      notifyBufferTrigger('js-error');
    },
    true,
  );

  // Unhandled promise rejections — full serialization (message/name/stack)
  addListener(window, 'unhandledrejection', (e) => {
    if (state.isPaused) return;
    const serialized = serializeReason(e.reason);
    pushError(
      'promise.rejection',
      serialized,
      `rejection|${serialized.name || ''}|${serialized.reason}`,
    );
    notifyBufferTrigger('rejection');
  });

  // CSP violations
  if (state.config.captureCspViolations !== false) {
    addListener(document, 'securitypolicyviolation', (e) => {
      if (state.isPaused) return;
      pushError(
        'csp.violation',
        {
          blockedURI: (e.blockedURI || '').slice(0, 2000),
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          sourceFile: (e.sourceFile || '').slice(0, 2000),
          position: `${e.lineNumber || 0}:${e.columnNumber || 0}`,
        },
        `csp|${e.effectiveDirective}|${e.blockedURI}`,
      );
    });
  }

  // UI snapshot heuristics — trigger full snapshots on large DOM changes
  try {
    const config = state.config.uiHeuristics || {};
    if (config.enabled === false) return;
    const mutationThreshold = config.mutationThreshold || 250;
    const debounceMs = config.debounceMs || 800;
    const minSnapshotIntervalMs = config.minSnapshotIntervalMs || 15000;
    let lastSnapshotAt = Date.now();

    const scheduleSnapshot = () => {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        if (state.isPaused || Date.now() - lastSnapshotAt < minSnapshotIntervalMs) return;
        record.takeFullSnapshot();
        lastSnapshotAt = Date.now();
      }, debounceMs);
    };

    const mo = new MutationObserver((mutationList) => {
      if (state.isPaused) return;
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
    // Registered on state so endSession() can disconnect it.
    state.observer = mo;
  } catch (_) {
    // noop
  }
}

export function stopTracking() {
  if (!installed) return;
  for (const { target, type, handler, options } of listeners) {
    target.removeEventListener(type, handler, options);
  }
  if (state.observer) state.observer.disconnect();
  state.observer = null;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  seenErrors.clear();
  errorCount = 0;
  installed = false;
  listeners = [];
}
