import { DEFAULT_CONFIG } from './constants.js';

export const state = {
  config: { ...DEFAULT_CONFIG },
  events: [],
  networkBuffer: [],
  networkBufferBytes: 0,
  sessionStartedAt: null,
  userId: null,
  sessionId: null,
  stopRecording: null,
  isSending: false,
  sendingToken: null,
  observer: null,
  authToken: null,
  chunkTargetBytes: null,
  lastHref: null,
  forceStop: false,
  isPaused: false,
  eventsInterval: null,
  screenMapInterval: null,
  screenMapSyncInFlight: false,
  screenMapSyncQueued: false,
  screenMapSyncTimer: null,
  tokenRefreshTimer: null,
  originalFetch: null,
  interceptedFetch: null,
  deactivateFetchInterceptor: null,
  originalXHR: null,
  interceptedXHR: null,
  deactivateXhrInterceptor: null,
  resourceObserver: null,
  resourceCount: 0,
  isInitialized: false,
  initializationInFlight: false,
  captureReady: false,
  lifecycleAbortController: null,
  inlinedAssetNodes: [],
  inlinedStylesheetOwners: [],
  lifecycleId: 0,
  beforeUnloadHandler: null,
  pageHideHandler: null,
  lastActivity: null,
  idleInterval: null,
  idleListeners: [],
  pausedByIdle: false,
  longTaskObserver: null,
  sessionCapTimer: null,
  bufferMode: false,
  bufferUpgradeInFlight: false,
  bufferUpgradeToken: null,
  sessionRotationInFlight: false,
  onSessionExpired: null,
  featureFlags: {},
};

/**
 * Reset all state to initial values.
 * Used by endSession() to clean up.
 */
export function resetState() {
  state.lifecycleId += 1;
  state.config = { ...DEFAULT_CONFIG };
  state.events = [];
  state.networkBuffer = [];
  state.networkBufferBytes = 0;
  state.sessionStartedAt = null;
  state.userId = null;
  state.sessionId = null;
  state.stopRecording = null;
  state.isSending = false;
  state.sendingToken = null;
  state.observer = null;
  state.authToken = null;
  state.chunkTargetBytes = null;
  state.lastHref = null;
  state.forceStop = true;
  state.isPaused = false;
  state.eventsInterval = null;
  state.screenMapInterval = null;
  state.screenMapSyncInFlight = false;
  state.screenMapSyncQueued = false;
  if (state.screenMapSyncTimer) {
    clearTimeout(state.screenMapSyncTimer);
  }
  state.screenMapSyncTimer = null;
  if (state.tokenRefreshTimer) {
    clearTimeout(state.tokenRefreshTimer);
  }
  state.tokenRefreshTimer = null;
  state.originalFetch = null;
  state.interceptedFetch = null;
  state.deactivateFetchInterceptor = null;
  state.originalXHR = null;
  state.interceptedXHR = null;
  state.deactivateXhrInterceptor = null;
  state.resourceObserver = null;
  state.resourceCount = 0;
  state.isInitialized = false;
  state.initializationInFlight = false;
  state.captureReady = false;
  state.lifecycleAbortController = null;
  state.inlinedAssetNodes = [];
  state.inlinedStylesheetOwners = [];
  state.beforeUnloadHandler = null;
  state.pageHideHandler = null;
  state.lastActivity = null;
  state.idleInterval = null;
  state.idleListeners = [];
  state.pausedByIdle = false;
  state.longTaskObserver = null;
  if (state.sessionCapTimer) {
    clearTimeout(state.sessionCapTimer);
  }
  state.sessionCapTimer = null;
  state.bufferMode = false;
  state.bufferUpgradeInFlight = false;
  state.bufferUpgradeToken = null;
  state.sessionRotationInFlight = false;
  // Keep onSessionExpired — wired once by createCollector for the instance lifetime.
  state.featureFlags = {};
}
