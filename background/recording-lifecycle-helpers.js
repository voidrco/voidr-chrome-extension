(function exposeRecordingLifecycleHelpers(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.VoidrRecordingLifecycle = helpers;
})(
  typeof globalThis !== 'undefined' ? globalThis : this,
  function createRecordingLifecycleHelpers() {
    function isCollectorReadinessConfirmed(readiness) {
      return Boolean(
        readiness?.ready === true &&
          typeof readiness.sessionId === 'string' &&
          readiness.sessionId.trim(),
      );
    }

    function shouldResumeOnNavigation(recording) {
      return Boolean(recording && recording.lifecycle !== 'stopping');
    }

    function lifecycleToken(recording) {
      if (!recording?.lifecycleGeneration || !Number.isInteger(recording.lifecycleVersion)) {
        return null;
      }
      return {
        generation: recording.lifecycleGeneration,
        version: recording.lifecycleVersion,
      };
    }

    function matchesLifecycleToken(recording, token, allowedLifecycles = null) {
      if (
        !recording ||
        !token ||
        recording.lifecycleGeneration !== token.generation ||
        recording.lifecycleVersion !== token.version
      ) {
        return false;
      }
      return (
        !Array.isArray(allowedLifecycles) ||
        allowedLifecycles.length === 0 ||
        allowedLifecycles.includes(recording.lifecycle)
      );
    }

    function matchesLifecycleGeneration(recording, token, allowedLifecycles = null) {
      if (!recording || !token || recording.lifecycleGeneration !== token.generation) {
        return false;
      }
      return (
        !Array.isArray(allowedLifecycles) ||
        allowedLifecycles.length === 0 ||
        allowedLifecycles.includes(recording.lifecycle)
      );
    }

    function authorizeStopRequest(recording, expectedGeneration, senderTabId = null) {
      if (
        !recording ||
        typeof expectedGeneration !== 'string' ||
        !expectedGeneration ||
        recording.lifecycleGeneration !== expectedGeneration
      ) {
        return { authorized: false, reason: 'stale-generation' };
      }
      if (Number.isInteger(senderTabId) && !recording.trackedTabIds?.includes(senderTabId)) {
        return { authorized: false, reason: 'untracked-tab' };
      }
      return { authorized: true, reason: null };
    }

    /**
     * A service-worker restart or a child-tab navigation can leave the page's
     * live collector ahead of the persisted tab ledger. Recovery is allowed
     * only when the sender proves it is running the exact canonical collector
     * session for this generation; tab identity alone is never enough.
     */
    function canRecoverStopSender(recording, senderTabId, senderSessionId) {
      return Boolean(
        recording &&
          Number.isInteger(senderTabId) &&
          !recording.trackedTabIds?.includes(senderTabId) &&
          typeof senderSessionId === 'string' &&
          senderSessionId.length > 0 &&
          senderSessionId === recording.canonicalSessionId,
      );
    }

    /**
     * Extension-owned capability used only to recover a Stop click after the
     * MV3 worker/tab ledger drifted. The opaque value stays in the isolated
     * content-script closure and chrome.storage.session; it is never placed in
     * the page DOM, collector metadata or persisted recording projection.
     */
    function createStopCapabilityStore(storage, options = {}) {
      const prefix = options.prefix || 'voidrStopCapability:';
      const ttlMs = Number(options.ttlMs) || 24 * 60 * 60 * 1000;
      const now = typeof options.now === 'function' ? options.now : Date.now;
      const randomToken =
        typeof options.randomToken === 'function'
          ? options.randomToken
          : () => globalThis.crypto.randomUUID();
      let queue = Promise.resolve();
      const serialized = (operation) => {
        const result = queue.then(operation, operation);
        queue = result.catch(() => {});
        return result;
      };
      const keyFor = (generation, tabId) => `${prefix}${generation}:${tabId}`;
      const validIdentity = (generation, tabId, sessionId) =>
        typeof generation === 'string' &&
        Boolean(generation) &&
        Number.isInteger(tabId) &&
        typeof sessionId === 'string' &&
        Boolean(sessionId);
      const isLiveRecord = (record) =>
        Boolean(
          record &&
            typeof record.generation === 'string' &&
            record.generation &&
            Number.isInteger(record.tabId) &&
            typeof record.sessionId === 'string' &&
            record.sessionId &&
            typeof record.token === 'string' &&
            record.token &&
            Number.isFinite(Number(record.createdAt)) &&
            now() - Number(record.createdAt || 0) <= ttlMs,
        );

      async function issue(generation, tabId, sessionId) {
        if (!validIdentity(generation, tabId, sessionId)) return null;
        return serialized(async () => {
          const token = randomToken();
          if (typeof token !== 'string' || !token) return null;
          await storage.set({
            [keyFor(generation, tabId)]: {
              generation,
              tabId,
              sessionId,
              token,
              createdAt: now(),
            },
          });
          return token;
        });
      }

      async function verify(generation, tabId, sessionId, token) {
        if (!validIdentity(generation, tabId, sessionId) || typeof token !== 'string' || !token) {
          return false;
        }
        return serialized(async () => {
          const key = keyFor(generation, tabId);
          const result = await storage.get([key]);
          const record = result[key];
          if (!isLiveRecord(record)) {
            await storage.remove([key]);
            return false;
          }
          return (
            record.generation === generation &&
            record.tabId === tabId &&
            record.sessionId === sessionId &&
            record.token === token
          );
        });
      }

      async function discardGeneration(generation) {
        if (typeof generation !== 'string' || !generation) return;
        return serialized(async () => {
          const values = await storage.get(null);
          const keys = Object.entries(values)
            .filter(([key, record]) => key.startsWith(prefix) && record?.generation === generation)
            .map(([key]) => key);
          if (keys.length > 0) await storage.remove(keys);
        });
      }

      async function discardTab(tabId) {
        if (!Number.isInteger(tabId)) return;
        return serialized(async () => {
          const values = await storage.get(null);
          const keys = Object.entries(values)
            .filter(([key, record]) => key.startsWith(prefix) && record?.tabId === tabId)
            .map(([key]) => key);
          if (keys.length > 0) await storage.remove(keys);
        });
      }

      return { issue, verify, discardGeneration, discardTab };
    }

    function authorizeDiscardRequest(recording, expectedGeneration, senderTabId = null) {
      const authorization = authorizeStopRequest(recording, expectedGeneration, senderTabId);
      if (!authorization.authorized) return authorization;
      if (recording.lifecycle === 'stopping') {
        return { authorized: false, reason: 'stop-in-progress' };
      }
      return authorization;
    }

    async function resumeCollectorWithLifecycleChecks({
      token,
      isCurrent,
      runIfCurrent,
      fetchCollector,
      injectCollector,
      initializeCollector,
    }) {
      const collectorCode = await fetchCollector();
      const runGuarded = async (operation) => {
        if (typeof runIfCurrent === 'function') return runIfCurrent(token, operation);
        if (!(await isCurrent(token))) return { ran: false, value: undefined };
        return { ran: true, value: await operation() };
      };

      const injection = await runGuarded(() => injectCollector(collectorCode));
      if (!injection.ran) return { resumed: false, stage: 'before-injection' };

      const initialization = await runGuarded(initializeCollector);
      if (!initialization.ran) return { resumed: false, stage: 'before-initialization' };
      const sessionId = initialization.value;
      if (!(await isCurrent(token))) return { resumed: false, stage: 'after-initialization' };
      return { resumed: true, sessionId };
    }

    function createSingleFlightLatch() {
      let inFlight = null;
      return {
        begin() {
          if (inFlight) return { isOwner: false, promise: inFlight };
          let resolve;
          const promise = new Promise((resolveRequest) => {
            resolve = resolveRequest;
          });
          inFlight = promise;
          promise
            .finally(() => {
              if (inFlight === promise) inFlight = null;
            })
            .catch(() => {});
          return { isOwner: true, promise, resolve };
        },
      };
    }

    function createKeyedSingleFlightLatch() {
      const inFlightByKey = new Map();
      return {
        begin(key) {
          const existing = inFlightByKey.get(key);
          if (existing) return { isOwner: false, promise: existing };
          let resolve;
          const promise = new Promise((resolveRequest) => {
            resolve = resolveRequest;
          });
          inFlightByKey.set(key, promise);
          promise
            .finally(() => {
              if (inFlightByKey.get(key) === promise) inFlightByKey.delete(key);
            })
            .catch(() => {});
          return { isOwner: true, promise, resolve };
        },
      };
    }

    function createSerializedExecutor() {
      let queue = Promise.resolve();
      return function runSerialized(task) {
        const result = queue.then(task, task);
        queue = result.catch(() => {});
        return result;
      };
    }

    function planTrackedTabRemoval(recording, tabId) {
      if (!recording?.trackedTabIds?.includes(tabId)) return { action: 'ignore' };
      const trackedTabIds = recording.trackedTabIds.filter((id) => id !== tabId);
      const existingRemovals = Array.isArray(recording.unacknowledgedRemovals)
        ? recording.unacknowledgedRemovals
        : [];
      const tombstone = {
        tabId,
        generation: recording.lifecycleGeneration,
        sessionId: recording.canonicalSessionId || null,
        removedAt: Date.now(),
        acknowledged: false,
      };
      return {
        action: 'mark-removed',
        recording: {
          ...recording,
          tabId: trackedTabIds[0] ?? recording.tabId,
          currentTabId:
            recording.currentTabId === tabId
              ? (trackedTabIds[0] ?? recording.currentTabId)
              : recording.currentTabId,
          trackedTabIds,
          removedTabIds: [...new Set([...(recording.removedTabIds || []), tabId])],
          unacknowledgedRemovals: [
            ...existingRemovals.filter((removal) => removal?.tabId !== tabId),
            tombstone,
          ],
        },
      };
    }

    function reconcileRemovedTabsForRetry(recording, results) {
      const removedTabIds = [
        ...new Set(
          (results || [])
            .filter((result) => result?.removed === true && Number.isInteger(result.tabId))
            .map((result) => result.tabId),
        ),
      ];
      if (removedTabIds.length === 0) {
        return { policy: 'retry', removedTabIds, recording };
      }
      // A removed tab can never later produce its missing final-chunk ACK.
      // Healthy sibling sessions may still be sealed in this stop attempt, but
      // retaining the generation for retry would create a permanent loop.
      return { policy: 'terminal', removedTabIds, recording: null };
    }

    function markRecordingReady(recording, sessionId) {
      if (!recording || typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new Error('Cannot mark a recording ready without a confirmed session');
      }
      const confirmedSessionId = sessionId.trim();
      return {
        ...recording,
        lifecycle: 'recording',
        canonicalSessionId: confirmedSessionId,
        initOptions: {
          ...(recording.initOptions || {}),
          forcedSessionId: confirmedSessionId,
        },
        sessionIds: [...new Set([...(recording.sessionIds || []), confirmedSessionId])],
      };
    }

    async function cleanupFailedCollectorBootstrap({
      tabId,
      trackedTabIds,
      disableCsp,
      clearActive,
    }) {
      const tabIds = [
        ...new Set([...(trackedTabIds || []), tabId].filter((id) => Number.isInteger(id))),
      ];
      for (const trackedTabId of tabIds) {
        try {
          await disableCsp(trackedTabId);
        } catch (_) {}
      }
      await clearActive();
    }

    return {
      authorizeDiscardRequest,
      authorizeStopRequest,
      canRecoverStopSender,
      cleanupFailedCollectorBootstrap,
      createStopCapabilityStore,
      createKeyedSingleFlightLatch,
      createSerializedExecutor,
      createSingleFlightLatch,
      isCollectorReadinessConfirmed,
      lifecycleToken,
      markRecordingReady,
      matchesLifecycleGeneration,
      matchesLifecycleToken,
      planTrackedTabRemoval,
      reconcileRemovedTabsForRetry,
      resumeCollectorWithLifecycleChecks,
      shouldResumeOnNavigation,
    };
  },
);
