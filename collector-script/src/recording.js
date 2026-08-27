import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { isTasy, TASY_MASK_SELECTORS, VERIFICATION_OVERLAY_SELECTOR } from './constants.js';
import { state } from './state.js';
import { initFetchInterceptor } from './network/fetch-interceptor.js';
import { initXhrInterceptor } from './network/xhr-interceptor.js';
import { initResourceObserver } from './network/resource-observer.js';
import { initEventListeners } from './listeners/events.js';
import { initRoutingCapture } from './listeners/routing.js';
import { initTracking } from './listeners/tracking.js';
import { initClickEffect } from './listeners/click-effect.js';
import { initVitals } from './listeners/vitals.js';
import { initLongTasks } from './listeners/longtasks.js';
import { initWhiteScreenDetection } from './listeners/whitescreen.js';

// Loop and Verification captures need the same replay-grade profile.
function isLoopTestMode() {
  return ['loop-test', 'verification'].includes(state.config.meta?.mode);
}

/**
 * Start only the rrweb recording (no listeners or interceptors).
 * Use this when resuming a paused session to avoid re-registering listeners.
 */
export function startRrwebOnly() {
  const loopTest = isLoopTestMode();

  const plugins = [];
  // Loop Test baselines require console capture regardless of customer config.
  if (state.config.captureConsole || loopTest) {
    plugins.push(
      getRecordConsolePlugin({
        level: ['log', 'warn', 'error', 'info'],
      }),
    );
  }

  // Coarse privacy level (Datadog-style) on top of the fine-grained selectors:
  // 'mask' hides all text+inputs, 'mask-user-input' hides inputs only, 'allow'
  // records everything not covered by blockSelectors.
  const privacyLevel = state.config.privacyLevel;
  const maskAllText = privacyLevel === 'mask' || state.config.dataMasking.text;
  const maskInputs =
    privacyLevel === 'mask' ||
    privacyLevel === 'mask-user-input' ||
    state.config.dataMasking.inputs;

  // Build maskTextSelector: global mask > TASY hotfix > null
  const maskTextSelector = maskAllText ? '*' : isTasy ? TASY_MASK_SELECTORS.join(', ') : null;

  state.stopRecording = record({
    emit: (event) => state.events.push(event),
    plugins,
    recordCanvas: true,
    recordCrossOriginIframes: true,
    // Inline stylesheets so same-origin (and CORS-readable cross-origin) CSS is
    // embedded in the snapshot. The replay iframe runs under a strict CSP
    // (style-src 'self' 'unsafe-inline'), so external <link> CSS cannot be
    // fetched at replay time — inlining is what makes the layout render.
    inlineStylesheet: true,
    // Capture @font-face / web fonts. Without this, replay can only load fonts
    // that survive the replay-origin CSP (font-src 'self' fonts.gstatic.com
    // data:), so most custom fonts render as fallbacks.
    collectFonts: true,
    // Inline images as data URLs (subject to dataURLOptions below) so they show
    // under the replay CSP (img-src ... data:), instead of failing as cross-origin
    // requests. Disabled for Tasy (health/PII) to avoid persisting sensitive image
    // content; those sessions keep image references only.
    inlineImages: !isTasy,
    maskTextSelector,
    // Never persist raw inputs in repeatedly replayed baselines.
    maskAllInputs: loopTest || isTasy || maskInputs,
    blockSelector: [
      ...(state.config.dataMasking.blockSelectors || []),
      VERIFICATION_OVERLAY_SELECTOR,
    ]
      .filter(Boolean)
      .join(', '),
    // Frequent checkpoints keep baseline comparison windows bounded.
    checkoutEveryNms: loopTest ? 60000 : 120000,
    checkoutEveryNth: loopTest ? 500 : 1000,
    dataURLOptions: {
      type: 'image/webp',
      quality: 0.4,
    },
    sampling: {
      mousemove: loopTest ? 50 : 100,
      mouseInteraction: true,
      input: 'all',
      scroll: loopTest ? 100 : 250,
      canvas: 2,
    },
    slimDOMOptions: 'all',
  });
}

/**
 * Start the rrweb recording and all event listeners/interceptors.
 */
export function startRecording() {
  // Replay compilation requires network and console evidence in these modes.
  if (isLoopTestMode()) {
    state.config.networkCapture = true;
    state.config.captureConsole = true;
  }

  startRrwebOnly();
  initCaptureInfrastructure();
}

export function initCaptureInfrastructure() {
  initClickEffect();
  initEventListeners();
  initFetchInterceptor();
  initXhrInterceptor();
  initResourceObserver();
  initTracking();
  initRoutingCapture();
  initVitals();
  initLongTasks();
  initWhiteScreenDetection();
}
