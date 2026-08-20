(function exposeLoopBootstrapHelpers(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.VoidrLoopBootstrap = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLoopBootstrapHelpers() {
  const LOOP_BOOTSTRAP_PARAMS = Object.freeze([
    'voidr_token',
    'voidr_record',
    'voidr_mode',
    'voidr_bootstrap',
    'voidr_scenario_id',
    'voidr_cycle_id',
    'voidr_session_n',
  ]);
  const LOOP_FRAGMENT_VERSION = 'voidr-loop-v1';
  const LOOP_FRAGMENT_VERSION_V2 = 'voidr-loop-v2';
  const LOOP_LAUNCH_TOKEN_PATTERN = /^[a-z0-9]+\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{43}$/;

  function normalizeBase64UrlTransport(value) {
    if (typeof value !== 'string') return null;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch (_) {
      return null;
    }

    // A URL copied from an inline-code response can acquire exactly one
    // trailing Markdown backtick (` → %60). The signed token inside the
    // envelope remains authoritative, so accepting only this well-known
    // transport suffix restores the intended bytes without accepting general
    // Base64URL corruption.
    if (/^[A-Za-z0-9_.~-]+`$/.test(decoded)) return decoded.slice(0, -1);
    return decoded;
  }

  function decodeBase64UrlText(value) {
    if (value === '') return '';
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    try {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      return typeof Buffer !== 'undefined'
        ? Buffer.from(padded, 'base64').toString('utf8')
        : decodeURIComponent(
            Array.from(
              atob(padded),
              (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
            ).join(''),
          );
    } catch (_) {
      return null;
    }
  }

  function decodeBase64UrlJson(value) {
    const normalized = normalizeBase64UrlTransport(value);
    if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) return null;
    try {
      const base64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const json =
        typeof Buffer !== 'undefined'
          ? Buffer.from(padded, 'base64').toString('utf8')
          : decodeURIComponent(
              Array.from(
                atob(padded),
                (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
              ).join(''),
            );
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  function parseAndStripLoopDeepLink(href) {
    try {
      const url = new URL(href);
      const params = url.searchParams;
      const isLoopBootstrap =
        params.get('voidr_mode') === 'loop-test' ||
        (params.get('voidr_record') === '1' && params.has('voidr_scenario_id'));
      if (!isLoopBootstrap) {
        return null;
      }

      const scenarioId = params.get('voidr_scenario_id');
      const cycleId = params.get('voidr_cycle_id');
      let token = params.get('voidr_token');
      let originalHash = null;
      let transportVersion = null;
      let failureCode = null;
      const fragment = url.hash.slice(1);
      const securePrefixV2 = `${LOOP_FRAGMENT_VERSION_V2}=`;
      const securePrefix = `${LOOP_FRAGMENT_VERSION}=`;
      if (params.get('voidr_bootstrap') === 'v2' && fragment.startsWith(securePrefixV2)) {
        originalHash = '';
        const compact = normalizeBase64UrlTransport(fragment.slice(securePrefixV2.length));
        const parts = compact?.split('~') ?? [];
        const compactToken = parts[0];
        const restoredHash = parts.length <= 2 ? decodeBase64UrlText(parts[1] || '') : null;
        if (
          LOOP_LAUNCH_TOKEN_PATTERN.test(compactToken || '') &&
          typeof cycleId === 'string' &&
          cycleId &&
          restoredHash !== null
        ) {
          token = compactToken;
          originalHash = restoredHash;
          transportVersion = 'v2';
        } else {
          token = null;
          failureCode = 'malformed_bootstrap';
        }
      } else if (
        params.get('voidr_bootstrap') === 'v1' &&
        fragment.startsWith(securePrefix)
      ) {
        // A malformed secure envelope is still removed. It must never be left
        // in page history where a partial/corrupt capability could be exposed.
        originalHash = '';
        const envelope = decodeBase64UrlJson(fragment.slice(securePrefix.length));
        token = typeof envelope?.token === 'string' && envelope.token ? envelope.token : null;
        if (typeof envelope?.originalHash === 'string') originalHash = envelope.originalHash;
        if (!token) failureCode = 'malformed_bootstrap';
      } else if (fragment.startsWith(securePrefixV2) || fragment.startsWith(securePrefix)) {
        // Version mismatch/corruption must fail closed and still remove the
        // capability-shaped fragment before application code can retain it.
        originalHash = '';
        token = null;
        failureCode = 'malformed_bootstrap';
      }

      for (const key of LOOP_BOOTSTRAP_PARAMS) url.searchParams.delete(key);
      if (originalHash !== null) {
        url.hash = originalHash;
      }
      return {
        staged:
          scenarioId && token
            ? {
                scenarioId,
                token,
                ...(cycleId ? { cycleId } : {}),
                ...(transportVersion ? { transportVersion } : {}),
              }
            : null,
        safeUrl: url.toString(),
        failureCode: scenarioId && !token ? failureCode || 'missing_capability' : null,
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * A generated Loop URL is a fresh recording entry point. Browsers can restore
   * a previous same-origin scroll position before rrweb takes its first full
   * snapshot, which displaces page headers in the replay. Keep this behavior
   * scoped to automatic Loop bootstraps so manual captures remain faithful.
   */
  function prepareAutomaticLoopViewport(target) {
    if (!target || typeof target.scrollTo !== 'function') return false;
    try {
      if (target.history && 'scrollRestoration' in target.history) {
        target.history.scrollRestoration = 'manual';
      }
    } catch (_) {}
    try {
      target.scrollTo(0, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  function createStagingStore(storage, options = {}) {
    const prefix = options.prefix || 'voidrLoopBootstrap:';
    const ttlMs = Number(options.ttlMs) || 5 * 60 * 1000;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const keyFor = (tabId) => `${prefix}${tabId}`;

    async function stage(tabId, staged) {
      if (
        !Number.isInteger(tabId) ||
        typeof staged?.scenarioId !== 'string' ||
        !staged.scenarioId ||
        typeof staged?.token !== 'string' ||
        !staged.token ||
        (staged.transportVersion === 'v2' &&
          (typeof staged.cycleId !== 'string' || !staged.cycleId))
      ) {
        return false;
      }
      await storage.set({
        [keyFor(tabId)]: { ...staged, stagedAt: now() },
      });
      return true;
    }

    async function consume(tabId) {
      if (!Number.isInteger(tabId)) return null;
      const key = keyFor(tabId);
      const result = await storage.get([key]);
      await storage.remove([key]);
      const staged = result[key];
      if (
        !staged ||
        now() - Number(staged.stagedAt || 0) > ttlMs ||
        typeof staged.scenarioId !== 'string' ||
        typeof staged.token !== 'string'
      ) {
        return null;
      }
      return {
        scenarioId: staged.scenarioId,
        token: staged.token,
        ...(typeof staged.cycleId === 'string' ? { cycleId: staged.cycleId } : {}),
        ...(typeof staged.transportVersion === 'string'
          ? { transportVersion: staged.transportVersion }
          : {}),
      };
    }

    async function discard(tabId) {
      if (Number.isInteger(tabId)) await storage.remove([keyFor(tabId)]);
    }

    return { stage, consume, discard };
  }

  function createGenerationCapabilityStore(storage, options = {}) {
    const prefix = options.prefix || 'voidrLoopCapability:';
    // Mirrors the service's conservative recording-lifetime attach capability.
    // Bootstrap authorization remains short-lived and is never stored here.
    const ttlMs = Number(options.ttlMs) || 24 * 60 * 60 * 1000;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const activeLeases = new Map();
    let nextLeaseId = 0;
    let queue = Promise.resolve();
    const keyFor = (generation) => `${prefix}${generation}`;
    const serialized = (operation) => {
      const result = queue.then(operation, operation);
      queue = result.catch(() => {});
      return result;
    };

    function isValidIdentity(generation, tabId, scenarioId) {
      return (
        typeof generation === 'string' &&
        Boolean(generation) &&
        Number.isInteger(tabId) &&
        typeof scenarioId === 'string' &&
        Boolean(scenarioId)
      );
    }

    function isValidRecord(record, generation, tabId = null, scenarioId = null) {
      return Boolean(
        record &&
          record.generation === generation &&
          Number.isInteger(record.tabId) &&
          typeof record.scenarioId === 'string' &&
          record.scenarioId &&
          typeof record.token === 'string' &&
          record.token &&
          now() - Number(record.createdAt || 0) <= ttlMs &&
          (tabId === null || record.tabId === tabId) &&
          (scenarioId === null || record.scenarioId === scenarioId),
      );
    }

    async function stage(generation, tabId, scenarioId, token) {
      if (!isValidIdentity(generation, tabId, scenarioId) || typeof token !== 'string' || !token) {
        return false;
      }
      const key = keyFor(generation);
      if (activeLeases.has(key)) return false;
      await storage.set({
        [key]: {
          generation,
          tabId,
          scenarioId,
          token,
          createdAt: now(),
        },
      });
      return true;
    }

    async function has(generation, tabId, scenarioId) {
      if (!isValidIdentity(generation, tabId, scenarioId)) return false;
      const key = keyFor(generation);
      const result = await storage.get([key]);
      const record = result[key];
      if (!isValidRecord(record, generation)) {
        await storage.remove([key]);
        return false;
      }
      return record.tabId === tabId && record.scenarioId === scenarioId;
    }

    async function lease(generation, scenarioId) {
      if (
        typeof generation !== 'string' ||
        !generation ||
        typeof scenarioId !== 'string' ||
        !scenarioId
      ) {
        return null;
      }
      const key = keyFor(generation);
      if (activeLeases.has(key)) return null;
      const result = await storage.get([key]);
      const record = result[key];
      if (!isValidRecord(record, generation, null, scenarioId)) {
        await storage.remove([key]);
        return null;
      }
      const capabilityLease = Object.freeze({
        generation,
        scenarioId,
        tabId: record.tabId,
        token: record.token,
        leaseId: ++nextLeaseId,
      });
      activeLeases.set(key, capabilityLease);
      return capabilityLease;
    }

    function matchesActiveLease(capabilityLease) {
      if (!capabilityLease || typeof capabilityLease.generation !== 'string') return false;
      return activeLeases.get(keyFor(capabilityLease.generation)) === capabilityLease;
    }

    async function commit(capabilityLease) {
      if (!matchesActiveLease(capabilityLease)) return false;
      const key = keyFor(capabilityLease.generation);
      activeLeases.delete(key);
      await storage.remove([key]);
      return true;
    }

    async function release(capabilityLease) {
      if (!matchesActiveLease(capabilityLease)) return false;
      activeLeases.delete(keyFor(capabilityLease.generation));
      return true;
    }

    async function discardGeneration(generation) {
      if (typeof generation === 'string' && generation) {
        const key = keyFor(generation);
        activeLeases.delete(key);
        await storage.remove([key]);
      }
    }

    async function discardTab(tabId) {
      if (!Number.isInteger(tabId)) return;
      const values = await storage.get(null);
      const keys = Object.entries(values)
        .filter(([key, record]) => key.startsWith(prefix) && record?.tabId === tabId)
        .map(([key]) => key);
      for (const [key, capabilityLease] of activeLeases) {
        if (capabilityLease.tabId === tabId) activeLeases.delete(key);
      }
      if (keys.length > 0) await storage.remove(keys);
    }

    async function purgeExpired() {
      const values = await storage.get(null);
      const keys = Object.entries(values)
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key, record]) => !isValidRecord(record, key.slice(prefix.length)))
        .map(([key]) => key);
      for (const key of keys) activeLeases.delete(key);
      if (keys.length > 0) await storage.remove(keys);
    }

    return {
      stage: (...args) => serialized(() => stage(...args)),
      has: (...args) => serialized(() => has(...args)),
      lease: (...args) => serialized(() => lease(...args)),
      commit: (...args) => serialized(() => commit(...args)),
      release: (...args) => serialized(() => release(...args)),
      discardGeneration: (...args) => serialized(() => discardGeneration(...args)),
      discardTab: (...args) => serialized(() => discardTab(...args)),
      purgeExpired: (...args) => serialized(() => purgeExpired(...args)),
    };
  }

  async function attachSessionWithCapability({
    capabilityStore,
    lifecycleGeneration,
    scenarioId,
    sessionId,
    endpoint,
    fetchImpl = fetch,
  }) {
    const capabilityLease = await capabilityStore.lease(lifecycleGeneration, scenarioId);
    if (!capabilityLease) {
      throw new Error('Loop Test session attach authorization is unavailable or expired');
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token: capabilityLease.token, lifecycleGeneration }),
      });
      if (!response.ok) {
        throw new Error(`Loop Test session attach failed (HTTP ${response.status})`);
      }
      // Any 2xx response confirms the service accepted the attachment. This
      // includes its idempotent success path when this session is already attached.
      await capabilityStore.commit(capabilityLease);
      return response.json();
    } catch (error) {
      // A terminal discard may have invalidated this lease while fetch was in
      // flight; release is intentionally a harmless no-op in that case.
      await capabilityStore.release(capabilityLease);
      throw error;
    }
  }

  function buildLoopCodeHandoffPath({ scenarioId, cycleId, agent = 'codex' }) {
    const safeScenarioId = String(scenarioId || '').trim();
    const safeCycleId = String(cycleId || '').trim();
    const safeAgent = ['codex', 'cursor', 'claude_code'].includes(agent) ? agent : 'codex';
    if (!safeScenarioId || !safeCycleId || safeScenarioId.length > 200 || safeCycleId.length > 200) {
      throw new Error('Loop code handoff coordinates are missing or invalid');
    }
    return (
      `/loops/${encodeURIComponent(safeScenarioId)}/consolidated` +
      `?handoff=1&cycle=${encodeURIComponent(safeCycleId)}&agent=${safeAgent}`
    );
  }

  return {
    LOOP_BOOTSTRAP_PARAMS,
    LOOP_FRAGMENT_VERSION,
    LOOP_FRAGMENT_VERSION_V2,
    attachSessionWithCapability,
    buildLoopCodeHandoffPath,
    createGenerationCapabilityStore,
    createStagingStore,
    parseAndStripLoopDeepLink,
    prepareAutomaticLoopViewport,
  };
});
