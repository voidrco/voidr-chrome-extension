import { record } from 'rrweb';
import { VOIDR_VERSION, isAutomationEnvironment } from './constants.js';
import { state, resetState } from './state.js';
import { sleep, safeStringify, truncate } from './utils/helpers.js';
import { initUser, initSession, authenticateSession } from './session.js';
import {
  sendEvents,
  sendNetworkEvents,
  handleUnload,
  flushEvents,
  syncScreenMap,
  syncScreenMapBeacon,
  finalizeSessionBeacon,
  scheduleTokenRefresh,
} from './transport.js';
import { initCaptureInfrastructure, startRecording, startRrwebOnly } from './recording.js';
import { sendEnvironmentBundle } from './environment-bundle.js';
import { initIdleWatch, stopIdleWatch } from './listeners/idle.js';
import { inlineIconFonts } from './assets/inline-fonts.js';
import { inlineUnreadableStylesheets } from './assets/inline-stylesheets.js';
import { ElementMapper } from './element-mapper.js';
import { stopClickEffect } from './listeners/click-effect.js';
import { stopLongTasks } from './listeners/longtasks.js';
import { initWhiteScreenDetection, stopWhiteScreenDetection } from './listeners/whitescreen.js';
import { stopEventListeners } from './listeners/events.js';
import { captureRouteOnResume, stopRoutingCapture } from './listeners/routing.js';
import { captureManualError, stopTracking } from './listeners/tracking.js';
import { armBufferMode, disarmBufferMode } from './buffer-mode.js';

const isLifecycleActive = (lifecycleId) =>
  state.lifecycleId === lifecycleId && state.isInitialized && !state.forceStop;

export function attachUnloadLifecycleHandlers({ target, onUnload }) {
  const useAnimationFrame = typeof target.requestAnimationFrame === 'function';
  const scheduleReset = useAnimationFrame
    ? target.requestAnimationFrame.bind(target)
    : (callback) => setTimeout(callback, 0);
  const cancelReset = useAnimationFrame
    ? target.cancelAnimationFrame?.bind(target)
    : (handle) => clearTimeout(handle);
  let handled = false;
  let resetHandle = null;

  const cancelPendingReset = () => {
    if (resetHandle == null) return;
    cancelReset?.(resetHandle);
    resetHandle = null;
  };
  const reset = () => {
    cancelPendingReset();
    handled = false;
  };
  const beforeUnload = () => {
    if (handled) return;
    handled = true;
    onUnload();
    resetHandle = scheduleReset(reset);
  };
  const pageHide = () => {
    cancelPendingReset();
    if (handled) return;
    handled = true;
    onUnload();
  };
  const pageShow = () => reset();

  target.addEventListener('beforeunload', beforeUnload);
  target.addEventListener('pagehide', pageHide);
  target.addEventListener('pageshow', pageShow);

  return {
    beforeUnload,
    pageHide,
    dispose() {
      cancelPendingReset();
      target.removeEventListener('beforeunload', beforeUnload);
      target.removeEventListener('pagehide', pageHide);
      target.removeEventListener('pageshow', pageShow);
    },
  };
}

/**
 * Create the VoidrCollector public API object.
 */
export function createCollector() {
  let unloadLifecycle = null;

  function startSendInterval() {
    if (state.eventsInterval) {
      clearInterval(state.eventsInterval);
    }
    state.eventsInterval = setInterval(() => {
      sendNetworkEvents();
      sendEvents();
    }, 7000);
  }

  function unregisterLifecycleHandlers() {
    if (typeof window === 'undefined') return;
    unloadLifecycle?.dispose();
    unloadLifecycle = null;
    state.beforeUnloadHandler = null;
    state.pageHideHandler = null;
  }

  function registerLifecycleHandlers() {
    if (typeof window === 'undefined') return;

    unregisterLifecycleHandlers();
    unloadLifecycle = attachUnloadLifecycleHandlers({
      target: window,
      onUnload: () => {
        handleUnload();
        syncScreenMapBeacon();
        finalizeSessionBeacon();
      },
    });
    state.beforeUnloadHandler = unloadLifecycle.beforeUnload;
    state.pageHideHandler = unloadLifecycle.pageHide;
  }

  function stopCaptureInfrastructure() {
    state.lifecycleAbortController?.abort();
    state.lifecycleAbortController = null;
    if (typeof state.stopRecording === 'function') state.stopRecording();
    state.stopRecording = null;
    stopRoutingCapture();
    stopEventListeners();
    stopTracking();
    stopClickEffect();
    stopLongTasks();
    stopWhiteScreenDetection();
    state.elementMapper?.stop();
    state.elementMapper = null;
    state.resourceObserver?.disconnect();
    state.resourceObserver = null;
    for (const node of state.inlinedAssetNodes) node.remove();
    for (const owner of state.inlinedStylesheetOwners) {
      owner.removeAttribute?.('data-voidr-css-inlined');
    }
    state.inlinedAssetNodes = [];
    state.inlinedStylesheetOwners = [];
    state.deactivateFetchInterceptor?.();
    state.deactivateXhrInterceptor?.();
    if (
      state.originalFetch &&
      typeof window !== 'undefined' &&
      window.fetch === state.interceptedFetch
    ) {
      window.fetch = state.originalFetch;
    }
    if (
      state.originalXHR &&
      typeof window !== 'undefined' &&
      window.XMLHttpRequest === state.interceptedXHR
    ) {
      window.XMLHttpRequest = state.originalXHR;
    }
    state.originalFetch = null;
    state.interceptedFetch = null;
    state.deactivateFetchInterceptor = null;
    state.originalXHR = null;
    state.interceptedXHR = null;
    state.deactivateXhrInterceptor = null;
  }

  function discardBufferedSession() {
    state.forceStop = true;
    stopCaptureInfrastructure();
    stopIdleWatch();
    disarmBufferMode();
    state.events.length = 0;
    state.networkBuffer.length = 0;
    state.networkBufferBytes = 0;
    try {
      sessionStorage.removeItem('voidr_jwt');
      sessionStorage.removeItem('voidr_session_id');
      sessionStorage.removeItem('voidr_last_activity');
    } catch (_) {}
    resetState();
  }

  function armSessionCap() {
    const mins = state.config.maxSessionDurationMinutes;
    if (!mins || mins <= 0) return;
    if (state.sessionCapTimer) clearTimeout(state.sessionCapTimer);
    state.sessionCapTimer = setTimeout(
      () => {
        rotateSession().catch(() => {});
      },
      mins * 60 * 1000,
    );
  }

  function finishPausedInitialization() {
    if (state.stopRecording) {
      state.stopRecording();
      state.stopRecording = null;
    }
    state.elementMapper?.stop();
    stopWhiteScreenDetection();
    registerLifecycleHandlers();
    if (!state.idleInterval) initIdleWatch(api);
    armSessionCap();
    sendEnvironmentBundle();
    console.log(`VoidrCollector v${VOIDR_VERSION} - Initialized (paused)`);
  }

  function startSessionServices() {
    startSendInterval();
    if (!state.screenMapInterval) {
      state.screenMapInterval = setInterval(() => syncScreenMap(), 7000);
    }
    registerLifecycleHandlers();
    if (!state.idleInterval) initIdleWatch(api);
    armSessionCap();
    sendEnvironmentBundle();
  }

  // Max-duration handling: finalize the current session and, when rotation is
  // enabled, continue recording under a fresh sessionId (Sentry/PostHog
  // pattern for long-lived tabs).
  //
  // reason:
  // - 'max-duration' — client-side cap timer fired; flush remaining events first
  // - 'server-expired' — collector returned 409 SESSION_EXPIRED; skip flush
  //   (the old sessionId is already rejected server-side)
  let rotationTask = null;

  function rotateSession(reason = 'max-duration') {
    if (!state.isInitialized || state.forceStop) return Promise.resolve();
    const lifecycleId = state.lifecycleId;
    if (rotationTask?.lifecycleId === lifecycleId) return rotationTask.promise;

    state.sessionRotationInFlight = true;
    const task = { lifecycleId, promise: null };
    rotationTask = task;
    task.promise = (async () => {
      try {
        const previousSessionId = state.sessionId;

        // Server already rejected the session — flushing would only 409-loop.
        // Drop undeliverable leftovers so the new session starts clean.
        if (reason === 'server-expired') {
          state.events.length = 0;
          state.networkBuffer.length = 0;
          state.networkBufferBytes = 0;
          state.isSending = false;
          state.sendingToken = null;
        } else {
          const drained = await flushEvents({ allowRotation: true });
          if (!isLifecycleActive(lifecycleId)) return;
          if (!drained) {
            state.sessionCapTimer = setTimeout(() => {
              rotateSession(reason).catch(() => {});
            }, 7000);
            return;
          }
        }
        if (!isLifecycleActive(lifecycleId)) return;
        finalizeSessionBeacon();

        if (!state.config.sessionRotation) {
          api.endSession();
          return;
        }

        state.sessionStartedAt = Date.now();
        state.sessionId = state.sessionStartedAt.toString();
        try {
          sessionStorage.setItem('voidr_session_id', state.sessionId);
          sessionStorage.setItem('voidr_last_activity', String(Date.now()));
          sessionStorage.removeItem('voidr_jwt');
        } catch (_) {
          // Ignore sessionStorage errors
        }

        try {
          const authenticated = await authenticateSession(lifecycleId);
          if (!isLifecycleActive(lifecycleId)) return;
          if (!authenticated) {
            api.endSession();
            return;
          }
          scheduleTokenRefresh();
        } catch (_) {
          if (isLifecycleActive(lifecycleId)) api.endSession();
          return;
        }

        if (!isLifecycleActive(lifecycleId)) return;
        state.elementMapper?.markDirty();
        state.events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'session.rotated',
            payload: { previousSessionId, reason },
          },
        });

        // New session must start from a valid snapshot.
        try {
          record.takeFullSnapshot(true);
        } catch (_) {
          // noop
        }

        armSessionCap();
        console.log(`VoidrCollector: Session rotated (${reason})`);
      } finally {
        if (rotationTask === task) rotationTask = null;
        if (state.lifecycleId === lifecycleId && state.isInitialized) {
          state.sessionRotationInFlight = false;
        }
      }
    })();

    return task.promise;
  }

  // Wire transport 409 SESSION_EXPIRED → rotate (single-flight via rotationPromise).
  state.onSessionExpired = (reason) => {
    rotateSession(reason).catch(() => {});
  };

  // Buffer-mode upgrade: an error occurred in an unsampled session and the
  // onErrorSampleRate dice roll passed — authenticate and start shipping the
  // buffered events plus everything after.
  async function upgradeBufferedSession(reason) {
    const lifecycleId = state.lifecycleId;
    disarmBufferMode();

    if (!isLifecycleActive(lifecycleId)) return;

    state.config.meta = {
      ...(state.config.meta || {}),
      replayType: 'buffer',
      bufferTrigger: reason,
    };

    try {
      const authenticated = await authenticateSession(lifecycleId);
      if (!isLifecycleActive(lifecycleId)) return;
      if (!authenticated) {
        discardBufferedSession();
        return;
      }
      scheduleTokenRefresh();
    } catch (_) {
      if (isLifecycleActive(lifecycleId)) discardBufferedSession();
      return;
    }

    sendNetworkEvents();
    await sendEvents();
    if (!isLifecycleActive(lifecycleId)) return;
    if (state.isPaused) {
      finishPausedInitialization();
      return;
    }
    startSessionServices();

    console.log(`VoidrCollector v${VOIDR_VERSION} - Buffered session upgraded (${reason})`);
  }

  const api = {
    version: VOIDR_VERSION,

    /**
     * Initialize the event collector.
     * @param {Object} options - Initialization configuration
     * @param {string} options.apiKey - Required API key
     * @param {string} [options.applicationId] - Application ID (optional)
     * @param {string} [options.environment] - Environment, e.g. "production", "staging" (optional)
     * @param {Object} [options.user] - User data
     * @param {string} [options.collectorUrl] - Alternative collector URL
     * @param {string} [options.forcedSessionId] - Session ID forced by the extension
     * @param {Object} [options.dataMasking] - Masking configuration
     * @param {number} [options.sessionTimeout] - Session timeout in minutes
     * @param {boolean} [options.system=false] - Flag for system/automation context
     * @param {boolean} [options.skipRecording=false] - Force skip recording
     * @param {number} [options.samplingRate=0.1] - Sampling rate 0 to 1 (0% to 100%, default 10%)
     */
    async init(options) {
      // Prevent duplicate initialization
      if (state.isInitialized) {
        console.warn(
          `VoidrCollector v${VOIDR_VERSION} - Already initialized. Skipping duplicate init() call.`,
        );
        return;
      }

      if (!options || !options.apiKey) {
        throw new Error('VoidrCollector: API Key is required');
      }

      state.forceStop = false;
      state.isInitialized = true;
      state.lifecycleId += 1;
      const lifecycleId = state.lifecycleId;
      state.initializationInFlight = true;

      try {
        console.log(`VoidrCollector v${VOIDR_VERSION} - Initializing...`);

        // Merge configuration
        state.config = { ...state.config, ...options };

        // ========== Skip recording checks ==========

        // 1. Check manual skipRecording override
        if (state.config.skipRecording === true) {
          console.log('VoidrCollector: Recording skipped (manual override via skipRecording)');
          state.isInitialized = false;
          return;
        }

        // 2. Detect automation environment (skip check when system: true)
        if (!state.config.system && isAutomationEnvironment()) {
          console.log('VoidrCollector: Recording skipped (automation environment detected)');
          state.isInitialized = false;
          return;
        }

        // 3. Check sampling rate
        let sampled = true;
        if (state.config.samplingRate < 1) {
          sampled = Math.random() <= state.config.samplingRate;
        }

        if (!sampled) {
          // Buffer mode: keep recording in memory and upgrade on error.
          if (state.config.onErrorSampleRate > 0) {
            state.sessionStartedAt = Date.now();
            initUser();
            initSession();
            armBufferMode(upgradeBufferedSession, discardBufferedSession);
            startRecording();
            state.elementMapper = new ElementMapper();
            state.elementMapper.start();
            state.captureReady = true;
            console.log(`VoidrCollector v${VOIDR_VERSION} - Initialized (buffer mode)`);
            return;
          }
          state.isInitialized = false;
          return;
        }

        // ===========================================

        // Initialize IDs
        state.sessionStartedAt = Date.now();
        initUser();
        initSession();

        // Validate API key and obtain JWT before starting recording
        try {
          const authenticated = await authenticateSession(lifecycleId);
          if (!isLifecycleActive(lifecycleId)) return;
          if (!authenticated) {
            state.isInitialized = false;
            return;
          }
          // Renew the ingest token before it expires so long-lived tabs don't hit
          // a 401 on the chunk-send path (which surfaces as a scary console error).
          scheduleTokenRefresh();
        } catch (err) {
          if (!isLifecycleActive(lifecycleId)) return;
          console.error('VoidrCollector: Failed to validate API Key', err);
          state.isInitialized = false;
          return;
        }

        // Inline replay-critical assets BEFORE the first snapshot so the replay
        // (different origin, strict CSP) renders faithfully: unreadable
        // cross-origin stylesheets as <style> text, and @font-face binaries as
        // data: URIs (instead of tofu □). Both share one time budget and are
        // best-effort. Stylesheets run first so their @font-face rules are visible.
        try {
          const assetController = new AbortController();
          state.lifecycleAbortController = assetController;
          const assetDeadline = Date.now() + 1500;
          await inlineUnreadableStylesheets(lifecycleId, assetController.signal, assetDeadline);
          await inlineIconFonts(lifecycleId, assetController.signal, assetDeadline);
        } catch {}

        if (!isLifecycleActive(lifecycleId)) return;

        if (state.isPaused) {
          initCaptureInfrastructure();
          state.elementMapper = new ElementMapper();
          state.captureReady = true;
          finishPausedInitialization();
          return;
        }

        // Start recording
        startRecording();

        // Start element mapper (client-side screen map builder)
        state.elementMapper = new ElementMapper();
        state.elementMapper.start();
        state.captureReady = true;

        await sleep(2000);

        if (!isLifecycleActive(lifecycleId)) return;

        // If paused during the sleep (SSE arrived), don't start sending
        if (state.isPaused) {
          finishPausedInitialization();
          return;
        }

        sendNetworkEvents();
        await sendEvents();
        if (!isLifecycleActive(lifecycleId)) return;
        if (state.isPaused) {
          finishPausedInitialization();
          return;
        }

        startSessionServices();

        console.log(`VoidrCollector v${VOIDR_VERSION} - Initialized successfully`);
      } finally {
        if (state.lifecycleId === lifecycleId) state.initializationInFlight = false;
      }
    },

    /**
     * Identify the current user.
     * @param {string} id - Unique user ID
     * @param {Object} traits - User attributes
     * @param {string} [traits.email] - User email
     * @param {string} [traits.name] - User name
     */
    async identify(id, traits = {}) {
      if (!id || !state.isInitialized || !state.sessionId) return;
      const context = {
        lifecycleId: state.lifecycleId,
        sessionId: state.sessionId,
        collectorUrl: state.config.collectorUrl,
        authToken: state.authToken,
      };
      const isCurrent = () =>
        state.lifecycleId === context.lifecycleId &&
        state.sessionId === context.sessionId &&
        !state.forceStop;

      state.userId = id;
      sessionStorage.setItem('voidr_user_id', id);
      state.config.user = { ...(state.config.user || {}), id, ...traits };

      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'user.identify',
          payload: { userId: id, ...traits },
        },
      });

      const identifyPayload = {
        sessionId: state.sessionId,
        userId: id,
        userEmail: traits.email || state.config.user?.email || null,
        userName: traits.name || state.config.user?.name || null,
        userTraits: traits,
      };

      const maxAttempts = 3;
      const baseDelays = [500, 1500, 3500];

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const res = await fetch(`${context.collectorUrl}/sessions/identify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(context.authToken ? { Authorization: `Bearer ${context.authToken}` } : {}),
            },
            body: safeStringify(identifyPayload),
          });
          if (!isCurrent()) return;

          if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
            break;
          }

          if (attempt < maxAttempts - 1) {
            const jitter = 1 + (Math.random() * 0.4 - 0.2);
            await sleep(baseDelays[attempt] * jitter);
            if (!isCurrent()) return;
          }
        } catch (err) {
          if (!isCurrent()) return;
          if (attempt < maxAttempts - 1) {
            const jitter = 1 + (Math.random() * 0.4 - 0.2);
            await sleep(baseDelays[attempt] * jitter);
            if (!isCurrent()) return;
          } else {
            state.events.push({
              type: 5,
              timestamp: Date.now(),
              data: {
                plugin: 'voidr.identify_failed',
                payload: { userId: id, error: err.message, attempts: maxAttempts },
              },
            });
          }
        }
      }
    },

    /**
     * Update configuration at runtime.
     * @param {Object} updates - New configuration values
     */
    updateConfig(updates) {
      state.config = { ...state.config, ...updates };
    },

    /**
     * End the current session.
     * Stops recording, clears intervals, removes sessionStorage data,
     * and restores intercepted originals.
     */
    endSession() {
      // Clear main interval
      if (state.eventsInterval) {
        clearInterval(state.eventsInterval);
        state.eventsInterval = null;
      }

      // Clear screen map sync interval
      if (state.screenMapInterval) {
        clearInterval(state.screenMapInterval);
        state.screenMapInterval = null;
      }

      unregisterLifecycleHandlers();

      // Stop idle detection
      stopIdleWatch();

      stopCaptureInfrastructure();
      disarmBufferMode();
      if (state.sessionCapTimer) {
        clearTimeout(state.sessionCapTimer);
        state.sessionCapTimer = null;
      }

      // Flush any trailing buffered events, then signal session completion so the
      // collector indexes the recording into ClickHouse promptly. Both run while
      // sessionId/state are still set (resetState() clears them below).
      try {
        handleUnload();
      } catch (e) {
        // Best-effort flush
      }
      finalizeSessionBeacon();

      // Refresh the environment bundle with the FINAL page state (storage/cookies
      // may have changed during the session). Fire-and-forget BEFORE resetState;
      // sendEnvironmentBundle snapshots the config/token synchronously.
      sendEnvironmentBundle();

      // Clear sessionStorage
      try {
        sessionStorage.removeItem('voidr_jwt');
        sessionStorage.removeItem('voidr_session_id');
        sessionStorage.removeItem('voidr_user_id');
        sessionStorage.removeItem('voidr_last_activity');
      } catch (e) {
        // Ignore sessionStorage errors
      }

      // Reset all state variables
      resetState();

      console.log('VoidrCollector: Session ended');
    },

    /**
     * Get the current session ID.
     * @returns {string|null} The current session ID or null if not initialized
     */
    getSessionId() {
      return state.sessionId;
    },

    /**
     * Force-flush all buffered events immediately.
     * Returns a Promise that resolves when all events have been sent to the server.
     * Does NOT stop recording — the session continues normally after flush.
     * Use this before stopping a recording session to ensure no events are lost.
     * @returns {Promise<void>}
     */
    async flush() {
      if (!state.isInitialized || !state.sessionId) return;
      await flushEvents();
    },

    /**
     * Pause recording and event collection.
     * Stops rrweb and clears the send interval immediately.
     * Buffered events are kept and will be sent on resume.
     * The session remains open — call resume() to continue.
     */
    pause() {
      if (!state.isInitialized || state.isPaused) return;
      state.isPaused = true;
      state.lifecycleAbortController?.abort();

      if (state.stopRecording && typeof state.stopRecording === 'function') {
        state.stopRecording();
        state.stopRecording = null;
      }

      if (state.eventsInterval) {
        clearInterval(state.eventsInterval);
        state.eventsInterval = null;
      }

      // No point syncing the screen map while nothing is being recorded.
      if (state.screenMapInterval) {
        clearInterval(state.screenMapInterval);
        state.screenMapInterval = null;
      }

      if (state.screenMapSyncTimer) {
        clearTimeout(state.screenMapSyncTimer);
        state.screenMapSyncTimer = null;
      }
      state.screenMapSyncQueued = false;

      state.elementMapper?.stop();
      stopWhiteScreenDetection();

      console.log('VoidrCollector: Recording paused');
    },

    /**
     * Resume recording after a pause.
     * Restarts rrweb (emits a new FullSnapshot) and the periodic send interval.
     * @returns {void}
     */
    resume() {
      if (!state.isInitialized || !state.isPaused) return;
      state.isPaused = false;
      if (state.initializationInFlight && !state.captureReady) return;

      startRrwebOnly();
      state.elementMapper?.start();
      captureRouteOnResume();
      initWhiteScreenDetection();
      startSendInterval();
      if (!state.screenMapInterval) {
        state.screenMapInterval = setInterval(() => syncScreenMap(), 7000);
      }
      registerLifecycleHandlers();
      sendNetworkEvents();
      sendEvents();

      console.log('VoidrCollector: Recording resumed');
    },

    /**
     * Get the current screen map snapshot from the ElementMapper.
     * @returns {object|null} The screen map or null if not initialized
     */
    getScreenMap() {
      return state.elementMapper?.getSnapshot() || null;
    },

    /**
     * Track a custom business event.
     * @param {string} name - Event name
     * @param {Object} [properties] - Arbitrary event properties
     */
    track(name, properties = {}) {
      if (!state.isInitialized || !name) return;
      let props = null;
      if (properties && typeof properties === 'object') {
        try {
          const str = safeStringify(properties);
          props = str.length > 4000 ? truncate(str, 4000) : properties;
        } catch (_) {
          props = null;
        }
      }
      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'custom.event',
          payload: { name: String(name).slice(0, 200), properties: props },
        },
      });
    },

    /**
     * Manually capture an exception with optional context.
     * @param {Error|*} error - Error object (or any value)
     * @param {Object} [context] - Additional context
     */
    captureException(error, context = {}) {
      if (!state.isInitialized) return;
      captureManualError(error, context);
    },

    /**
     * Record a feature flag evaluation so errors/friction can be correlated
     * with active flags.
     * @param {string} flag - Flag key
     * @param {*} value - Evaluated value
     */
    addFeatureFlagEvaluation(flag, value) {
      if (!state.isInitialized || !flag) return;
      const key = String(flag).slice(0, 200);
      const val =
        typeof value === 'object' && value !== null ? truncate(safeStringify(value), 500) : value;
      if (state.featureFlags[key] === val) return;
      state.featureFlags[key] = val;
      state.events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'feature.flag',
          payload: { flag: key, value: val },
        },
      });
    },
  };

  return api;
}
