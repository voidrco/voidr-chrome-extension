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
import { startRecording, startRrwebOnly } from './recording.js';
import { sendEnvironmentBundle } from './environment-bundle.js';
import { initIdleWatch, stopIdleWatch } from './listeners/idle.js';
import { inlineIconFonts } from './assets/inline-fonts.js';
import { inlineUnreadableStylesheets } from './assets/inline-stylesheets.js';
import { ElementMapper } from './element-mapper.js';
import { stopClickEffect } from './listeners/click-effect.js';
import { stopLongTasks } from './listeners/longtasks.js';
import { captureManualError } from './listeners/tracking.js';
import { armBufferMode, disarmBufferMode } from './buffer-mode.js';

/**
 * Create the VoidrCollector public API object.
 */
export function createCollector() {
  function startSendInterval() {
    if (state.eventsInterval) {
      clearInterval(state.eventsInterval);
    }
    state.eventsInterval = setInterval(() => {
      sendEvents();
      sendNetworkEvents();
    }, 7000);
  }

  function unregisterLifecycleHandlers() {
    if (typeof window === 'undefined') return;

    if (state.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', state.beforeUnloadHandler);
      state.beforeUnloadHandler = null;
    }

    if (state.pageHideHandler) {
      window.removeEventListener('pagehide', state.pageHideHandler);
      state.pageHideHandler = null;
    }
  }

  function registerLifecycleHandlers() {
    if (typeof window === 'undefined') return;

    unregisterLifecycleHandlers();

    state.beforeUnloadHandler = () => {
      handleUnload();
      syncScreenMapBeacon();
      finalizeSessionBeacon();
    };
    state.pageHideHandler = () => {
      handleUnload();
      syncScreenMapBeacon();
      finalizeSessionBeacon();
    };

    window.addEventListener('beforeunload', state.beforeUnloadHandler);
    window.addEventListener('pagehide', state.pageHideHandler);
  }

  function armSessionCap() {
    const mins = state.config.maxSessionDurationMinutes;
    if (!mins || mins <= 0) return;
    if (state.sessionCapTimer) clearTimeout(state.sessionCapTimer);
    state.sessionCapTimer = setTimeout(() => {
      rotateSession().catch(() => {});
    }, mins * 60 * 1000);
  }

  // Max-duration handling: finalize the current session and, when rotation is
  // enabled, continue recording under a fresh sessionId (Sentry/PostHog
  // pattern for long-lived tabs).
  //
  // reason:
  // - 'max-duration' — client-side cap timer fired; flush remaining events first
  // - 'server-expired' — collector returned 409 SESSION_EXPIRED; skip flush
  //   (the old sessionId is already rejected server-side)
  let rotationPromise = null;

  function rotateSession(reason = 'max-duration') {
    if (!state.isInitialized || state.forceStop) return Promise.resolve();
    if (rotationPromise) return rotationPromise;

    // Set synchronously so concurrent sendEvents/sync calls stop immediately.
    state.sessionRotationInFlight = true;
    rotationPromise = (async () => {
      try {
        const previousSessionId = state.sessionId;

        // Server already rejected the session — flushing would only 409-loop.
        // Drop undeliverable leftovers so the new session starts clean.
        if (reason === 'server-expired') {
          state.events.length = 0;
          state.networkBuffer.length = 0;
        } else {
          await flushEvents();
        }
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
          const authenticated = await authenticateSession();
          if (!authenticated) {
            api.endSession();
            return;
          }
          scheduleTokenRefresh();
        } catch (_) {
          api.endSession();
          return;
        }

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
        rotationPromise = null;
        // endSession() clears this via resetState; only clear when still alive.
        if (state.isInitialized) {
          state.sessionRotationInFlight = false;
        }
      }
    })();

    return rotationPromise;
  }

  // Wire transport 409 SESSION_EXPIRED → rotate (single-flight via rotationPromise).
  state.onSessionExpired = (reason) => {
    rotateSession(reason).catch(() => {});
  };

  // Buffer-mode upgrade: an error occurred in an unsampled session and the
  // onErrorSampleRate dice roll passed — authenticate and start shipping the
  // buffered events plus everything after.
  async function upgradeBufferedSession(reason) {
    disarmBufferMode();

    state.config.meta = {
      ...(state.config.meta || {}),
      replayType: 'buffer',
      bufferTrigger: reason,
    };

    try {
      const authenticated = await authenticateSession();
      if (!authenticated) {
        state.isInitialized = false;
        return;
      }
      scheduleTokenRefresh();
    } catch (_) {
      state.isInitialized = false;
      return;
    }

    await sendEvents();
    startSendInterval();
    if (!state.screenMapInterval) {
      state.screenMapInterval = setInterval(() => syncScreenMap(), 7000);
    }
    registerLifecycleHandlers();
    initIdleWatch(api);
    armSessionCap();
    sendEnvironmentBundle();

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

      state.isInitialized = true;

      console.log(`VoidrCollector v${VOIDR_VERSION} - Initializing...`);

      // Basic validation
      if (!options || !options.apiKey) {
        throw new Error('VoidrCollector: API Key is required');
      }

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
          armBufferMode(upgradeBufferedSession);
          startRecording();
          state.elementMapper = new ElementMapper();
          state.elementMapper.start();
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
        const authenticated = await authenticateSession();
        if (!authenticated) {
          state.isInitialized = false;
          return;
        }
        // Renew the ingest token before it expires so long-lived tabs don't hit
        // a 401 on the chunk-send path (which surfaces as a scary console error).
        scheduleTokenRefresh();
      } catch (err) {
        console.error('VoidrCollector: Failed to validate API Key', err);
        state.isInitialized = false;
        return;
      }

      // Inline replay-critical assets BEFORE the first snapshot so the replay
      // (different origin, strict CSP) renders faithfully: unreadable
      // cross-origin stylesheets as <style> text, and @font-face binaries as
      // data: URIs (instead of tofu □). Both run in parallel, time-boxed and
      // best-effort — never block recording. Stylesheets must land first-ish
      // so newly readable @font-face rules are visible to the font pass, hence
      // the sequential await inside the same guard.
      try {
        await inlineUnreadableStylesheets();
        await inlineIconFonts();
      } catch {
        /* best-effort: recording proceeds regardless */
      }

      // Start recording
      startRecording();

      // Start element mapper (client-side screen map builder)
      state.elementMapper = new ElementMapper();
      state.elementMapper.start();

      await sleep(2000);

      // If paused during the sleep (SSE arrived), don't start sending
      if (state.isPaused) {
        // Stop rrweb that startRecording() just started
        if (state.stopRecording) {
          state.stopRecording();
          state.stopRecording = null;
        }
        console.log(`VoidrCollector v${VOIDR_VERSION} - Initialized (paused)`);
        registerLifecycleHandlers();
        return;
      }

      await sendEvents();

      // Set up periodic sending
      startSendInterval();

      // Set up periodic screen map sync (dedicated endpoint, aligned with chunk send interval)
      state.screenMapInterval = setInterval(() => syncScreenMap(), 7000);

      registerLifecycleHandlers();

      // Auto-pause recording on prolonged inactivity (idle/forgotten tabs)
      initIdleWatch(api);

      // Hard cap on session duration (finalize + rotate)
      armSessionCap();

      // Snapshot the environment bundle (storage + cookies + viewport/UA) for
      // future local replay. Best-effort, non-blocking — never gates recording.
      sendEnvironmentBundle();

      console.log(`VoidrCollector v${VOIDR_VERSION} - Initialized successfully`);
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
          const res = await fetch(`${state.config.collectorUrl}/sessions/identify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
            },
            body: safeStringify(identifyPayload),
          });

          if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
            break;
          }

          if (attempt < maxAttempts - 1) {
            const jitter = 1 + (Math.random() * 0.4 - 0.2);
            await sleep(baseDelays[attempt] * jitter);
          }
        } catch (err) {
          if (attempt < maxAttempts - 1) {
            const jitter = 1 + (Math.random() * 0.4 - 0.2);
            await sleep(baseDelays[attempt] * jitter);
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
      // Stop rrweb recording
      if (state.stopRecording && typeof state.stopRecording === 'function') {
        state.stopRecording();
        state.stopRecording = null;
      }

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

      // Stop click-effect observation, long task observer, buffer mode, cap timer
      stopClickEffect();
      stopLongTasks();
      disarmBufferMode();
      if (state.sessionCapTimer) {
        clearTimeout(state.sessionCapTimer);
        state.sessionCapTimer = null;
      }

      // Stop element mapper
      if (state.elementMapper) {
        state.elementMapper.stop();
        state.elementMapper = null;
      }

      // Stop MutationObserver if active
      if (state.observer && typeof state.observer.disconnect === 'function') {
        state.observer.disconnect();
        state.observer = null;
      }

      // Restore original fetch
      if (state.originalFetch && typeof window !== 'undefined') {
        window.fetch = state.originalFetch;
        state.originalFetch = null;
      }

      // Restore original XMLHttpRequest
      if (state.originalXHR && typeof window !== 'undefined') {
        window.XMLHttpRequest = state.originalXHR;
        state.originalXHR = null;
      }

      // Disconnect the static-resource PerformanceObserver
      if (state.resourceObserver && typeof state.resourceObserver.disconnect === 'function') {
        try {
          state.resourceObserver.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        state.resourceObserver = null;
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

      startRrwebOnly();
      startSendInterval();
      if (!state.screenMapInterval) {
        state.screenMapInterval = setInterval(() => syncScreenMap(), 7000);
      }
      registerLifecycleHandlers();
      sendEvents();
      sendNetworkEvents();

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
