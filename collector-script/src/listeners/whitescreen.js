import { state } from '../state.js';

// web-see-style white screen detection: sample viewport points via
// elementFromPoint and flag the page as blank when every sample resolves to a
// container element. Polls after a positive so recoveries are reported too.
const SAMPLE_COUNT = 9;
const INITIAL_DELAY_MS = 4000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 10;

const DEFAULT_CONTAINERS = ['html', 'body', '#app', '#root'];

let timers = new Set();

function schedule(action, delay) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    action();
  }, delay);
  timers.add(timer);
}

function isContainer(el, containers, skeleton, initialSkeletonMarkup) {
  if (!el) return true;
  const selector = containers.join(',');
  try {
    if (el.matches && el.matches(selector)) return true;
  } catch {
    /* invalid selector — treat as content */
  }
  // Skeleton-screen projects: unchanged skeleton markup still counts as blank.
  if (skeleton && initialSkeletonMarkup && document.body) {
    return document.body.innerHTML === initialSkeletonMarkup;
  }
  return false;
}

function samplePoints() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const points = [];
  for (let i = 1; i <= SAMPLE_COUNT; i++) {
    // horizontal, vertical and diagonal cross-sections of the viewport
    points.push([(w * i) / (SAMPLE_COUNT + 1), h / 2]);
    points.push([w / 2, (h * i) / (SAMPLE_COUNT + 1)]);
  }
  return points;
}

export function initWhiteScreenDetection() {
  const cfg = state.config.whiteScreen;
  if (!cfg || cfg.enabled !== true) return;
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return;

  const containers = Array.isArray(cfg.containers) && cfg.containers.length
    ? cfg.containers
    : DEFAULT_CONTAINERS;
  const skeleton = cfg.skeleton === true;
  let initialSkeletonMarkup = null;
  if (skeleton) {
    try {
      initialSkeletonMarkup = document.body ? document.body.innerHTML : null;
    } catch {
      initialSkeletonMarkup = null;
    }
  }

  const isWhite = () => {
    const points = samplePoints();
    for (const [x, y] of points) {
      let el = null;
      try {
        el = document.elementFromPoint(x, y);
      } catch {
        el = null;
      }
      if (!isContainer(el, containers, skeleton, initialSkeletonMarkup)) return false;
    }
    return true;
  };

  const emit = (status, extra) => {
    state.events.push({
      type: 5,
      timestamp: Date.now(),
      data: {
        plugin: 'page.whitescreen',
        payload: { status, url: window.location.href.slice(0, 2000), ...extra },
      },
    });
  };

  const startedAt = Date.now();
  let polls = 0;

  const check = () => {
    if (state.forceStop || state.isPaused) return;
    if (!isWhite()) {
      if (polls > 0) {
        emit('recovered', { durationMs: Date.now() - startedAt, attempts: polls });
      }
      return;
    }
    polls += 1;
    if (polls === 1) {
      emit('white', { durationMs: Date.now() - startedAt, attempts: polls });
    }
    if (polls < MAX_POLLS) {
      schedule(check, POLL_INTERVAL_MS);
    } else {
      emit('persistent', { durationMs: Date.now() - startedAt, attempts: polls });
    }
  };

  schedule(check, INITIAL_DELAY_MS);
}

export function stopWhiteScreenDetection() {
  for (const timer of timers) clearTimeout(timer);
  timers = new Set();
}
