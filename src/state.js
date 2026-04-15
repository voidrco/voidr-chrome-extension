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
  originalFetch: null,
  originalXHR: null,
  isInitialized: false,
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
  state.originalFetch = null;
  state.originalXHR = null;
  state.isInitialized = false;
}
