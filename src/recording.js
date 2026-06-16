import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { isTasy, TASY_MASK_SELECTORS } from './constants.js';
import { state } from './state.js';
import { initFetchInterceptor } from './network/fetch-interceptor.js';
import { initXhrInterceptor } from './network/xhr-interceptor.js';
import { initEventListeners } from './listeners/events.js';
import { initRoutingCapture } from './listeners/routing.js';
import { initTracking } from './listeners/tracking.js';

/**
 * Start only the rrweb recording (no listeners or interceptors).
 * Use this when resuming a paused session to avoid re-registering listeners.
 */
export function startRrwebOnly() {
  const plugins = [];
  if (state.config.captureConsole) {
    plugins.push(
      getRecordConsolePlugin({
        level: ['log', 'warn', 'error', 'info'],
      }),
    );
  }

  // Build maskTextSelector: global mask > TASY hotfix > null
  const maskTextSelector = state.config.dataMasking.text
    ? '*'
    : isTasy
      ? TASY_MASK_SELECTORS.join(', ')
      : null;

  state.stopRecording = record({
    emit: (event) => state.events.push(event),
    plugins,
    recordCanvas: true,
    recordCrossOriginIframes: true,
    inlineStylesheet: true,
    inlineImages: false,
    maskTextSelector,
    maskAllInputs: isTasy || state.config.dataMasking.inputs,
    blockSelector: state.config.dataMasking.blockSelectors?.join(', '),
    checkoutEveryNms: 120000,
    checkoutEveryNth: 1000,
    dataURLOptions: {
      type: 'image/webp',
      quality: 0.4,
    },
    sampling: {
      mousemove: 100,
      mouseInteraction: true,
      input: 'all',
      scroll: 250,
      canvas: 2,
    },
    slimDOMOptions: 'all',
  });
}

/**
 * Start the rrweb recording and all event listeners/interceptors.
 */
export function startRecording() {
  startRrwebOnly();
  initEventListeners();
  initFetchInterceptor();
  initXhrInterceptor();
  initTracking();
  initRoutingCapture();
}
