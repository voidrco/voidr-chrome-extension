import { record } from 'rrweb';
import { state } from '../state.js';
import { scheduleScreenMapSync } from '../transport.js';
import { recordLiveContext } from '../live-context.js';

let installed = false;
let listeners = [];
let timers = new Set();
let originalPushState = null;
let originalReplaceState = null;
let patchedPushState = null;
let patchedReplaceState = null;
let snapshotTimer = null;
let lastCapturedUrl = null;

function schedule(action, delay) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    action();
  }, delay);
  timers.add(timer);
}

function addListener(target, type, handler) {
  target.addEventListener(type, handler);
  listeners.push({ target, type, handler });
}

function routeKey(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return `${parsed.pathname}${parsed.hash}`;
  } catch {
    return url;
  }
}

function capturePageView({ url, from = null, trigger }) {
  lastCapturedUrl = url;
  const title = document.title || '';
  const timestamp = Date.now();
  state.events.push({
    type: 5,
    timestamp,
    data: { plugin: 'page.view', payload: { url, title, from, trigger } },
  });
  recordLiveContext('pages', { url, title, from, trigger }, { timestamp });
}

export function captureRouteOnResume() {
  const current = window.location.href;
  if (!current || lastCapturedUrl === current) return;
  const from = lastCapturedUrl;
  state.lastHref = current;
  capturePageView({ url: current, from, trigger: 'resume' });
  state.elementMapper?.onPageView(current, document.title || '');
  scheduleScreenMapSync();
}

function addRouteEvent(from, to, trigger) {
  try {
    if (typeof record?.addCustomEvent === 'function') {
      record.addCustomEvent('route', { from, to, trigger });
    }
  } catch (_) {}
}

function takeRouteSnapshot(from, to) {
  if (routeKey(from) === routeKey(to)) return;
  try {
    if (typeof record?.takeFullSnapshot === 'function') record.takeFullSnapshot();
  } catch (_) {}
}

function scheduleRouteSnapshot(from, to) {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (!installed || state.isPaused) return;
    takeRouteSnapshot(from, to);
  }, 100);
}

export function initRoutingCapture() {
  if (installed) return;
  installed = true;
  const initialUrl = window.location.href;
  state.lastHref = initialUrl;
  schedule(() => {
    if (state.isPaused || state.lastHref !== initialUrl || lastCapturedUrl === initialUrl) return;
    capturePageView({ url: initialUrl, trigger: 'initial' });
    state.elementMapper?.onPageView(initialUrl, document.title || '');
  }, 100);

  const onRouteChange = (trigger) => {
    const current = window.location.href;
    if (!current || current === state.lastHref) return;
    const from = state.lastHref;
    state.lastHref = current;
    if (state.isPaused) return;
    schedule(() => {
      if (!installed || state.isPaused || lastCapturedUrl === current) return;
      capturePageView({ url: current, from, trigger });
    }, 100);
    scheduleRouteSnapshot(from, current);
    state.elementMapper?.onPageView(current, document.title || '');
    scheduleScreenMapSync();
    addRouteEvent(from, current, trigger);
  };

  const pushState = history.pushState;
  const replaceState = history.replaceState;
  originalPushState = pushState;
  originalReplaceState = replaceState;
  patchedPushState = function () {
    const result = pushState.apply(this, arguments);
    if (installed) onRouteChange('pushState');
    return result;
  };
  patchedReplaceState = function () {
    const result = replaceState.apply(this, arguments);
    if (installed) onRouteChange('replaceState');
    return result;
  };
  history.pushState = patchedPushState;
  history.replaceState = patchedReplaceState;
  addListener(window, 'popstate', () => onRouteChange('popstate'));
  addListener(window, 'hashchange', () => onRouteChange('hashchange'));
}

export function stopRoutingCapture() {
  if (!installed) return;
  for (const { target, type, handler } of listeners) target.removeEventListener(type, handler);
  for (const timer of timers) clearTimeout(timer);
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (history.pushState === patchedPushState) history.pushState = originalPushState;
  if (history.replaceState === patchedReplaceState) history.replaceState = originalReplaceState;
  installed = false;
  listeners = [];
  timers = new Set();
  originalPushState = null;
  originalReplaceState = null;
  patchedPushState = null;
  patchedReplaceState = null;
  snapshotTimer = null;
  lastCapturedUrl = null;
}
