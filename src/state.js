import { DEFAULT_CONFIG } from './constants.js';

export const state = {
  config: { ...DEFAULT_CONFIG },
  events: [],
  networkBuffer: [],
  sessionStartedAt: null,
  userId: null,
  sessionId: null,
  stopRecording: null,
  isSending: false,
  observer: null,
  authToken: null,
  lastHref: null,
  forceStop: false,
  isPaused: false,
  eventsInterval: null,
  screenMapInterval: null,
  screenMapSyncInFlight: false,
  screenMapSyncQueued: false,
  screenMapSyncTimer: null,
  originalFetch: null,
  originalXHR: null,
  isInitialized: false,
  beforeUnloadHandler: null,
  pageHideHandler: null,
  lastActivity: null,
  idleInterval: null,
  idleListeners: [],
  pausedByIdle: false,
};

/**
 * Reset all state to initial values.
 * Used by endSession() to clean up.
 */
export function resetState() {
  state.config = { ...DEFAULT_CONFIG };
  state.events = [];
  state.networkBuffer = [];
  state.sessionStartedAt = null;
  state.userId = null;
  state.sessionId = null;
  state.stopRecording = null;
  state.isSending = false;
  state.observer = null;
  state.authToken = null;
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
  state.originalFetch = null;
  state.originalXHR = null;
  state.isInitialized = false;
  state.beforeUnloadHandler = null;
  state.pageHideHandler = null;
  state.lastActivity = null;
  state.idleInterval = null;
  state.idleListeners = [];
  state.pausedByIdle = false;
}
