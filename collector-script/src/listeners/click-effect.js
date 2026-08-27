import { state } from '../state.js';
import { generateSelector } from '../utils/helpers.js';
import { updateLiveContext } from '../live-context.js';

// Interaction settlement: for every click, observe the page for a short window
// and report which effect signals followed (DOM mutation, scroll, navigation,
// network, selection, visibility). The decoder uses this to tell dead clicks
// apart from clicks that opened dropdowns/modals without any network traffic.
const EFFECT_WINDOW_MS = 2000;
const VISIBILITY_BEFORE_MS = 100;
const MAX_PENDING_CLICKS = 25;

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';

let clickSeq = 0;
let signals = null;
let pending = [];
let observer = null;
let listeners = [];
let timers = new Set();
let installed = false;
let originalPushState = null;
let originalReplaceState = null;
let patchedPushState = null;
let patchedReplaceState = null;

function now() {
  return Date.now();
}

/** Called by the network interceptors when a request starts. */
export function markNetworkActivity() {
  if (signals) signals.network = now();
}

function isInteractive(el) {
  try {
    if (!el || !el.closest) return false;
    return Boolean(el.closest(INTERACTIVE_SELECTOR)) || hasPointerCursor(el);
  } catch {
    return false;
  }
}

function hasPointerCursor(el) {
  try {
    return window.getComputedStyle(el).cursor === 'pointer';
  } catch {
    return false;
  }
}

function hasAnchorAncestor(el) {
  try {
    return Boolean(el && el.closest && el.closest('a'));
  } catch {
    return false;
  }
}

function deltaAfter(ts, signalTs) {
  if (signalTs == null || signalTs < ts || signalTs - ts > EFFECT_WINDOW_MS) return null;
  return signalTs - ts;
}

function settle(click) {
  pending = pending.filter((c) => c !== click);
  if (!signals || state.isPaused) return;

  const payload = {
    clickId: click.clickId,
    selector: click.selector,
    tag: click.tag,
    interactive: click.interactive,
    anchorAncestor: click.anchorAncestor,
    mutationMs: deltaAfter(click.ts, signals.mutation),
    scrollMs: deltaAfter(click.ts, signals.scroll),
    navMs: deltaAfter(click.ts, signals.nav),
    networkMs: deltaAfter(click.ts, signals.network),
    selectionMs: deltaAfter(click.ts, signals.selection),
    visibilityMs: deltaAfter(click.ts, signals.visibility),
    // visibilitychange right before the click (tab focus) — PostHog-style guard
    visibilityBefore:
      signals.visibility != null &&
      click.ts - signals.visibility >= 0 &&
      click.ts - signals.visibility <= VISIBILITY_BEFORE_MS,
  };

  state.events.push({
    type: 5,
    timestamp: now(),
    data: {
      plugin: 'user.click.effect',
      payload,
    },
  });
  updateLiveContext('clicks', click.clickId, { effects: payload });
}

function onClick(e) {
  if (!installed || state.isPaused) return;

  clickSeq += 1;
  const clickId = `c${clickSeq}`;
  // Same event object reaches the bubble-phase user.click listener, which
  // reads this to correlate click and effect rows.
  try {
    e.__voidrClickId = clickId;
  } catch {
    /* frozen event — correlation lost, effect still emitted */
  }

  if (pending.length >= MAX_PENDING_CLICKS) return;

  const target = e.composedPath ? e.composedPath()[0] : e.target;
  const selector = target ? generateSelector(target) : '';
  try {
    e.__voidrSelector = selector;
  } catch {}
  const click = {
    clickId,
    ts: now(),
    selector,
    tag: target?.tagName || '',
    interactive: isInteractive(target),
    anchorAncestor: hasAnchorAncestor(target),
    href: window.location.href,
  };
  pending.push(click);

  const timer = setTimeout(() => {
    timers.delete(timer);
    // href change without a history event (full reload lost anyway) still
    // counts as navigation for SPA flows that bypass pushState hooks.
    if (!state.isPaused && window.location.href !== click.href) {
      signals.nav = Math.max(signals.nav ?? 0, click.ts + 1);
    }
    settle(click);
  }, EFFECT_WINDOW_MS + 50);
  timers.add(timer);
}

export function initClickEffect() {
  if (typeof window === 'undefined' || installed) return;
  installed = true;

  signals = {
    mutation: null,
    scroll: null,
    nav: null,
    network: null,
    selection: null,
    visibility: null,
  };
  pending = [];
  listeners = [];

  try {
    observer = new MutationObserver(() => {
      signals.mutation = now();
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  } catch {
    observer = null;
  }

  const add = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push({ target, type, handler, options });
  };

  add(document, 'click', onClick, { capture: true, passive: true });
  add(window, 'scroll', () => (signals.scroll = now()), { capture: true, passive: true });
  add(document, 'selectionchange', () => (signals.selection = now()), { passive: true });
  add(document, 'visibilitychange', () => (signals.visibility = now()));
  add(window, 'popstate', () => (signals.nav = now()));
  add(window, 'hashchange', () => (signals.nav = now()));

  const pushState = history.pushState;
  const replaceState = history.replaceState;
  originalPushState = pushState;
  originalReplaceState = replaceState;
  patchedPushState = function () {
    if (signals) signals.nav = now();
    return pushState.apply(this, arguments);
  };
  patchedReplaceState = function () {
    if (signals) signals.nav = now();
    return replaceState.apply(this, arguments);
  };
  history.pushState = patchedPushState;
  history.replaceState = patchedReplaceState;
}

export function stopClickEffect() {
  if (!installed) return;
  installed = false;

  if (observer) {
    try {
      observer.disconnect();
    } catch {
      /* noop */
    }
    observer = null;
  }
  for (const { target, type, handler, options } of listeners) {
    try {
      target.removeEventListener(type, handler, options);
    } catch {
      /* noop */
    }
  }
  listeners = [];
  for (const timer of timers) clearTimeout(timer);
  timers = new Set();
  pending = [];
  signals = null;
  if (history.pushState === patchedPushState) history.pushState = originalPushState;
  if (history.replaceState === patchedReplaceState) history.replaceState = originalReplaceState;
  originalPushState = null;
  originalReplaceState = null;
  patchedPushState = null;
  patchedReplaceState = null;
}
