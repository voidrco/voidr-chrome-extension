// Background script para a extensão Voidr Testing Assistant

// Carrega variáveis de ambiente, se disponíveis
try {
  importScripts('config/env.js');
} catch (_) {
  try {
    importScripts('../config/env.js');
  } catch (__) {}
}
// Optional, gitignored localhost overrides. Worker import failures are caught,
// so production packages remain quiet and use only config/env.js.
try {
  importScripts('config/env.local.js');
} catch (_) {
  try {
    importScripts('../config/env.local.js');
  } catch (__) {}
}
try {
  importScripts('background/session-stop-helpers.js');
} catch (_) {
  importScripts('session-stop-helpers.js');
}
try {
  importScripts('background/recording-lifecycle-helpers.js');
} catch (_) {
  importScripts('recording-lifecycle-helpers.js');
}
try {
  importScripts('shared/recording-ux-helpers.js');
} catch (_) {
  importScripts('../shared/recording-ux-helpers.js');
}
try {
  importScripts('shared/loop-bootstrap-helpers.js');
} catch (_) {
  importScripts('../shared/loop-bootstrap-helpers.js');
}
try {
  importScripts('shared/verification-evidence-helpers.js');
} catch (_) {
  importScripts('../shared/verification-evidence-helpers.js');
}

// Configurações da API - com overrides via __VOIDR_ENV__
const __ENV__ = (typeof globalThis !== 'undefined' && globalThis.__VOIDR_ENV__) || {};
const DEFAULTS = {
  baseUrl: 'https://api.voidr.co/v1',
  platformUrl: 'https://platform.voidr.co',
  collectorUrl: 'https://collector.voidr.co',
  auth0Domain: 'bounties4.us.auth0.com',
  auth0ClientId: 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS',
  auth0Audience: 'https://service.bounties4.com/',
};

const RESOLVED = {
  baseUrl: __ENV__.VOIDR_API_BASE_URL || DEFAULTS.baseUrl,
  platformUrl: __ENV__.VOIDR_PLATFORM_URL || DEFAULTS.platformUrl,
  collectorUrl: __ENV__.VOIDR_COLLECTOR_URL || DEFAULTS.collectorUrl,
  collectorScriptUrl:
    __ENV__.VOIDR_COLLECTOR_SCRIPT_URL ||
    'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js',
  auth0Domain: __ENV__.VOIDR_AUTH0_DOMAIN || DEFAULTS.auth0Domain,
  auth0ClientId: __ENV__.VOIDR_AUTH0_CLIENT_ID || DEFAULTS.auth0ClientId,
  auth0Audience: __ENV__.VOIDR_AUTH0_AUDIENCE || DEFAULTS.auth0Audience,
};
const LOCAL_VERIFICATION_ADAPTER =
  __ENV__.VERIFICATION_LOCAL_ADAPTER_ENABLED === true ||
  __ENV__.VERIFICATION_LOCAL_ADAPTER_ENABLED === 'true';
const LOCAL_VERIFICATION_KEY = __ENV__.VERIFICATION_LOCAL_DEV_KEY || 'voidr-verification-local';
const LOCAL_VERIFICATION_ORGANIZATION =
  __ENV__.VERIFICATION_LOCAL_ORGANIZATION || 'org_verification_local';
const LOCAL_VERIFICATION_COLLECTOR_KEY =
  __ENV__.VERIFICATION_LOCAL_COLLECTOR_API_KEY || 'voidr-verification-collector-local';

const API_CONFIG = {
  baseUrl: RESOLVED.baseUrl,
  platformUrl: RESOLVED.platformUrl,
  collectorUrl: RESOLVED.collectorUrl,
  collectorScriptUrl: RESOLVED.collectorScriptUrl,
  auth0: {
    domain: RESOLVED.auth0Domain,
    clientId: RESOLVED.auth0ClientId,
    audience: RESOLVED.auth0Audience,
    cacheKey: `@@auth0spajs@@::${RESOLVED.auth0ClientId}::${RESOLVED.auth0Audience}::openid profile email`,
  },
};

// Estado global da autenticação
let globalAuthState = {
  isAuthenticated: false,
  user: null,
  token: null,
};

// Track last popup window id to refocus instead of creating a new one
let lastPopupWindowId = null;
// Track last active content tab id to forward messages (not the popup window)
let lastActiveContentTabId = null;

const ACTIVE_RECORDING_STORAGE_KEY = 'voidrActiveRecording';
const LOOP_STARTUP_FAILURE_STORAGE_KEY = 'voidrLoopStartupFailure';
const LOOP_FINALIZATION_STORAGE_KEY = 'voidrLastLoopFinalization';
const loopBootstrapStaging = VoidrLoopBootstrap.createStagingStore(chrome.storage.session);
const loopCapabilitySecrets = VoidrLoopBootstrap.createGenerationCapabilityStore(
  chrome.storage.session,
);
const stopCapabilitySecrets = VoidrRecordingLifecycle.createStopCapabilityStore(
  chrome.storage.session,
);

// Active recording state — persisted because MV3 service workers are ephemeral
let activeRecording = null;
const runWithRecordingStateLock = VoidrRecordingLifecycle.createSerializedExecutor();
const stopRequestLatch = VoidrRecordingLifecycle.createKeyedSingleFlightLatch();

function isTrustedAssistantSender(sender) {
  const popupRoot = chrome.runtime.getURL('popup/');
  return typeof sender?.url === 'string' && sender.url.startsWith(popupRoot);
}

// Helpers to persist assistant window id across service worker restarts
async function getStoredAssistantWindowId() {
  try {
    const res = await chrome.storage.local.get(['assistantWindowId']);
    return res.assistantWindowId || null;
  } catch (_) {
    return null;
  }
}
async function setStoredAssistantWindowId(id) {
  try {
    await chrome.storage.local.set({ assistantWindowId: id || null });
  } catch (_) {}
}
async function clearStoredAssistantWindowId(id) {
  try {
    const current = await getStoredAssistantWindowId();
    if (!id || current === id) await chrome.storage.local.remove(['assistantWindowId']);
  } catch (_) {}
}

function createRecordingSessionId() {
  return `voidr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createLifecycleGeneration() {
  return `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeActiveRecording(recording) {
  if (!recording || typeof recording !== 'object') return null;

  const lifecycleGeneration =
    (typeof recording.lifecycleGeneration === 'string' && recording.lifecycleGeneration) || null;
  const trackedTabIds = Array.from(
    new Set(
      (Array.isArray(recording.trackedTabIds)
        ? recording.trackedTabIds
        : [recording.tabId, recording.currentTabId]
      ).filter((tabId) => Number.isInteger(tabId)),
    ),
  );

  const canonicalSessionId =
    (typeof recording.canonicalSessionId === 'string' && recording.canonicalSessionId) ||
    (typeof recording.initOptions?.forcedSessionId === 'string' &&
      recording.initOptions.forcedSessionId) ||
    (Array.isArray(recording.sessionIds) && recording.sessionIds[0]) ||
    null;

  const unacknowledgedRemovals = Array.isArray(recording.unacknowledgedRemovals)
    ? recording.unacknowledgedRemovals
        .filter(
          (removal) =>
            Number.isInteger(removal?.tabId) &&
            removal.generation === lifecycleGeneration &&
            removal.acknowledged !== true,
        )
        .map((removal) => ({
          tabId: removal.tabId,
          generation: removal.generation,
          sessionId:
            typeof removal.sessionId === 'string' && removal.sessionId
              ? removal.sessionId
              : canonicalSessionId,
          removedAt: Number(removal.removedAt) || Date.now(),
          acknowledged: false,
        }))
    : [];

  if (!canonicalSessionId || (trackedTabIds.length === 0 && unacknowledgedRemovals.length === 0)) {
    return null;
  }

  const sessionIds = Array.from(
    new Set([
      canonicalSessionId,
      ...(Array.isArray(recording.sessionIds) ? recording.sessionIds : []),
    ]),
  );

  const currentTabId = trackedTabIds.includes(recording.currentTabId)
    ? recording.currentTabId
    : (trackedTabIds[0] ?? null);
  const {
    token: _token,
    voidr_token: _voidrToken,
    recordingToken: _recordingToken,
    capabilityToken: _capabilityToken,
    ...safeInitOptions
  } = recording.initOptions || {};
  const safeLoopTest = safeInitOptions.loopTest?.scenarioId
    ? {
        scenarioId: safeInitOptions.loopTest.scenarioId,
        cycleId: safeInitOptions.loopTest.cycleId,
        cycleNumber: safeInitOptions.loopTest.cycleNumber,
      }
    : undefined;
  const safeMeta = {
    ...(safeInitOptions.meta || {}),
    loopTest: safeInitOptions.meta?.loopTest?.scenarioId
      ? {
          scenarioId: safeInitOptions.meta.loopTest.scenarioId,
          cycleId: safeInitOptions.meta.loopTest.cycleId,
          cycleNumber: safeInitOptions.meta.loopTest.cycleNumber,
        }
      : undefined,
  };

  return {
    tabId: trackedTabIds[0] ?? null,
    currentTabId,
    trackedTabIds,
    canonicalSessionId,
    initOptions: {
      ...safeInitOptions,
      meta: safeMeta,
      loopTest: safeLoopTest,
      collectorUrl: API_CONFIG.collectorUrl,
      forcedSessionId: canonicalSessionId,
    },
    testCaseName: recording.testCaseName || recording.initOptions?.meta?.testCase || 'Test Case',
    mode: recording.mode || recording.initOptions?.meta?.mode || 'test-case',
    onboardingRunId:
      recording.onboardingRunId || recording.initOptions?.meta?.onboardingRunId || null,
    code: recording.code || recording.initOptions?.meta?.code || null,
    evidence: recording.evidence || recording.initOptions?.meta?.evidence || null,
    loopTest: recording.loopTest || recording.initOptions?.meta?.loopTest || null,
    flows: recording.flows || recording.initOptions?.meta?.flows || [],
    sessionIds,
    startedAt: recording.startedAt || Date.now(),
    lifecycle: ['starting', 'recording', 'stopping'].includes(recording.lifecycle)
      ? recording.lifecycle
      : 'recording',
    lifecycleGeneration:
      lifecycleGeneration || `legacy-${canonicalSessionId}-${Number(recording.startedAt) || 0}`,
    lifecycleVersion:
      Number.isInteger(recording.lifecycleVersion) && recording.lifecycleVersion >= 0
        ? recording.lifecycleVersion
        : 0,
    removedTabIds: Array.isArray(recording.removedTabIds)
      ? recording.removedTabIds.filter(Number.isInteger)
      : [],
    unacknowledgedRemovals,
  };
}

function withRecordingStateLock(task) {
  return runWithRecordingStateLock(task);
}

async function hydrateActiveRecordingUnlocked(force = false) {
  if (activeRecording && !force) return activeRecording;

  try {
    const result = await chrome.storage.local.get([ACTIVE_RECORDING_STORAGE_KEY]);
    activeRecording = normalizeActiveRecording(result[ACTIVE_RECORDING_STORAGE_KEY]);
  } catch (_) {
    activeRecording = null;
  }

  return activeRecording;
}

async function hydrateActiveRecording(force = false) {
  return withRecordingStateLock(() => hydrateActiveRecordingUnlocked(force));
}

async function persistActiveRecording() {
  try {
    if (activeRecording) {
      await chrome.storage.local.set({ [ACTIVE_RECORDING_STORAGE_KEY]: activeRecording });
    } else {
      await chrome.storage.local.remove([ACTIVE_RECORDING_STORAGE_KEY]);
    }
  } catch (_) {}
}

async function writeActiveRecordingUnlocked(recording) {
  activeRecording = normalizeActiveRecording(recording);
  await persistActiveRecording();
  return activeRecording;
}

async function setActiveRecording(recording) {
  return withRecordingStateLock(() => writeActiveRecordingUnlocked(recording));
}

async function claimActiveRecording(recording) {
  return withRecordingStateLock(async () => {
    await hydrateActiveRecordingUnlocked();
    if (activeRecording) return null;
    return writeActiveRecordingUnlocked(recording);
  });
}

async function clearActiveRecording() {
  return withRecordingStateLock(async () => {
    const generation = activeRecording?.lifecycleGeneration;
    activeRecording = null;
    await persistActiveRecording();
    await Promise.all([
      loopCapabilitySecrets.discardGeneration(generation),
      stopCapabilitySecrets.discardGeneration(generation),
    ]);
  });
}

function isActiveLifecycleGenerationCurrent(token, allowedLifecycles = ['starting', 'recording']) {
  return VoidrRecordingLifecycle.matchesLifecycleGeneration(
    activeRecording,
    token,
    allowedLifecycles,
  );
}

async function runWithActiveLifecycleGeneration(
  token,
  operation,
  allowedLifecycles = ['starting', 'recording'],
) {
  return withRecordingStateLock(async () => {
    if (!isActiveLifecycleGenerationCurrent(token, allowedLifecycles)) {
      return { ran: false, value: undefined };
    }
    return { ran: true, value: await operation() };
  });
}

async function updateActiveRecordingIfCurrent(token, update, allowedLifecycles = null) {
  return withRecordingStateLock(async () => {
    if (!VoidrRecordingLifecycle.matchesLifecycleToken(activeRecording, token, allowedLifecycles)) {
      return null;
    }
    const next =
      typeof update === 'function' ? update(activeRecording) : { ...activeRecording, ...update };
    return writeActiveRecordingUnlocked({
      ...next,
      lifecycleVersion: activeRecording.lifecycleVersion + 1,
    });
  });
}

async function updateActiveRecordingForGeneration(
  lifecycleGeneration,
  update,
  allowedLifecycles = null,
) {
  return withRecordingStateLock(async () => {
    if (
      !activeRecording ||
      activeRecording.lifecycleGeneration !== lifecycleGeneration ||
      (Array.isArray(allowedLifecycles) && !allowedLifecycles.includes(activeRecording.lifecycle))
    ) {
      return null;
    }
    const next =
      typeof update === 'function' ? update(activeRecording) : { ...activeRecording, ...update };
    return writeActiveRecordingUnlocked({
      ...next,
      lifecycleVersion: activeRecording.lifecycleVersion + 1,
    });
  });
}

async function clearActiveRecordingIfCurrent(token, beforeClear = null) {
  return withRecordingStateLock(async () => {
    if (!VoidrRecordingLifecycle.matchesLifecycleToken(activeRecording, token)) return false;
    if (beforeClear) await beforeClear(activeRecording);
    if (!VoidrRecordingLifecycle.matchesLifecycleToken(activeRecording, token)) return false;
    const generation = activeRecording.lifecycleGeneration;
    activeRecording = null;
    await persistActiveRecording();
    await Promise.all([
      loopCapabilitySecrets.discardGeneration(generation),
      stopCapabilitySecrets.discardGeneration(generation),
    ]);
    return true;
  });
}

async function clearActiveRecordingForGeneration(
  lifecycleGeneration,
  allowedLifecycles = null,
  beforeClear = null,
  { preserveLoopCapability = false } = {},
) {
  return withRecordingStateLock(async () => {
    const matches = () =>
      activeRecording?.lifecycleGeneration === lifecycleGeneration &&
      (!Array.isArray(allowedLifecycles) ||
        allowedLifecycles.length === 0 ||
        allowedLifecycles.includes(activeRecording.lifecycle));
    if (!matches()) return false;
    if (beforeClear) await beforeClear(activeRecording);
    if (!matches()) return false;
    const generation = activeRecording.lifecycleGeneration;
    activeRecording = null;
    await persistActiveRecording();
    await stopCapabilitySecrets.discardGeneration(generation);
    if (!preserveLoopCapability) {
      await loopCapabilitySecrets.discardGeneration(generation);
    }
    return true;
  });
}

async function getSafeRecordingState() {
  const recording = await hydrateActiveRecording();
  let startupFailure = null;
  let finalization = null;
  try {
    const [stored, sessionStored] = await Promise.all([
      chrome.storage.local.get([LOOP_STARTUP_FAILURE_STORAGE_KEY]),
      chrome.storage.session.get([LOOP_FINALIZATION_STORAGE_KEY]),
    ]);
    const failure = stored[LOOP_STARTUP_FAILURE_STORAGE_KEY];
    if (failure && typeof failure === 'object') {
      startupFailure = {
        reason: VoidrRecordingUx.safeFailureReason(failure.reason),
        failedAt: Number(failure.failedAt) || null,
      };
    }
    const lastFinalization = sessionStored[LOOP_FINALIZATION_STORAGE_KEY];
    if (
      lastFinalization &&
      typeof lastFinalization === 'object' &&
      Date.now() - Number(lastFinalization.updatedAt || 0) < 4 * 60 * 60 * 1000
    ) {
      finalization = lastFinalization;
    }
  } catch (_) {}
  return {
    active: VoidrRecordingUx.sanitizeActiveRecording(recording),
    startupFailure,
    finalization,
  };
}

async function persistLoopStartupFailure(reason) {
  const failure = {
    reason: VoidrRecordingUx.safeFailureReason(reason),
    failedAt: Date.now(),
  };
  await chrome.storage.local.set({ [LOOP_STARTUP_FAILURE_STORAGE_KEY]: failure });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  return failure;
}

async function clearLoopStartupFailure() {
  await chrome.storage.local.remove([LOOP_STARTUP_FAILURE_STORAGE_KEY]);
  await chrome.action.setBadgeText({ text: '' });
}

function isTrackedRecordingTab(recording, tabId) {
  return Boolean(recording && Number.isInteger(tabId) && recording.trackedTabIds?.includes(tabId));
}

async function attachTrackedRecordingTab(
  tabId,
  { makeCurrent = false, expectedToken = null } = {},
) {
  if (!Number.isInteger(tabId)) return null;
  return withRecordingStateLock(async () => {
    const recording = activeRecording || (await hydrateActiveRecordingUnlocked());
    if (!recording || recording.lifecycle === 'stopping') return null;
    if (
      expectedToken &&
      !VoidrRecordingLifecycle.matchesLifecycleGeneration(recording, expectedToken, [
        'starting',
        'recording',
      ])
    ) {
      return null;
    }

    const wasTracked = recording.trackedTabIds.includes(tabId);
    const shouldMakeCurrent = makeCurrent || !recording.currentTabId;
    if (wasTracked && (!shouldMakeCurrent || recording.currentTabId === tabId) && recording.tabId) {
      return recording;
    }

    const next = {
      ...recording,
      trackedTabIds: wasTracked ? recording.trackedTabIds : [...recording.trackedTabIds, tabId],
      currentTabId: shouldMakeCurrent ? tabId : recording.currentTabId,
      tabId: recording.tabId || tabId,
      lifecycleVersion: recording.lifecycleVersion + 1,
    };
    await writeActiveRecordingUnlocked(next);

    // Keep CSP enablement inside the lifecycle lock. Failed-start cleanup can
    // then snapshot every joined child without a delayed enable leaking a rule.
    if (!wasTracked) await enableCspBypassForTab(tabId);
    return activeRecording;
  });
}

// On window removed, clear stored id if it matches
chrome.windows.onRemoved.addListener(async (removedId) => {
  if (lastPopupWindowId === removedId) lastPopupWindowId = null;
  await clearStoredAssistantWindowId(removedId);
});

async function focusExistingAssistantWindow() {
  // 1) Try memory id
  if (lastPopupWindowId) {
    try {
      await chrome.windows.update(lastPopupWindowId, { focused: true, drawAttention: true });
      return lastPopupWindowId;
    } catch (_) {
      /* fallthrough */
    }
  }
  // 2) Try stored id
  const storedId = await getStoredAssistantWindowId();
  if (storedId) {
    try {
      await chrome.windows.update(storedId, { focused: true, drawAttention: true });
      lastPopupWindowId = storedId;
      return storedId;
    } catch (_) {
      await clearStoredAssistantWindowId(storedId);
    }
  }
  // 3) Scan all windows by URL
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup', 'normal'] });
    const targetUrl = chrome.runtime.getURL('popup/popup.html');
    for (const w of wins) {
      const match = (w.tabs || []).find((tab) => tab.url && tab.url.startsWith(targetUrl));
      if (match) {
        try {
          await chrome.tabs.update(match.id, { active: true });
        } catch (_) {}
        try {
          await chrome.windows.update(w.id, { focused: true, drawAttention: true });
        } catch (_) {}
        lastPopupWindowId = w.id;
        await setStoredAssistantWindowId(w.id);
        return w.id;
      }
    }
  } catch (_) {}
  return null;
}

async function openAssistantWindowAt(position) {
  return new Promise((resolve) => {
    const specs = {
      url: chrome.runtime.getURL('popup/popup.html'),
      type: 'popup',
      width: 472,
      height: 625,
      focused: true,
    };
    if (position && typeof position.left === 'number') specs.left = Math.max(0, position.left);
    if (position && typeof position.top === 'number') specs.top = Math.max(0, position.top);
    chrome.windows.create(specs, async (createdWin) => {
      lastPopupWindowId = createdWin?.id || null;
      await setStoredAssistantWindowId(lastPopupWindowId);
      resolve(createdWin?.id || null);
    });
  });
}

function isHttpUrl(u) {
  try {
    return /^https?:/i.test(String(u || ''));
  } catch (_) {
    return false;
  }
}

// ── SessionEnvironmentBundle: HttpOnly cookie capture ────────────────────────
// The collector-script (page context) can only read NON-HttpOnly cookies via
// document.cookie. The real auth session is almost always an HttpOnly cookie,
// which is invisible to page JS — so we capture the FULL cookie set here in the
// background using the chrome.cookies API (this is exactly why the "cookies"
// permission is requested in manifest.json) and POST it to the collector's
// environment-bundle endpoint, where it merges with the page bundle. This write
// carries the HttpOnly truth and overwrites the page's best-effort cookies.

function toPlaywrightSameSite(chromeSameSite) {
  switch (chromeSameSite) {
    case 'no_restriction':
      return 'None';
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    default:
      return 'Lax';
  }
}

async function captureAndUploadCookies(sessionId, pageUrl) {
  try {
    if (!sessionId || !pageUrl || !isHttpUrl(pageUrl)) return;
    if (!chrome.cookies?.getAll) return;
    if (!globalAuthState.token) await checkAuthenticationStatus();
    if (!globalAuthState.token) return;

    const rawCookies = await chrome.cookies.getAll({ url: pageUrl });
    if (!Array.isArray(rawCookies) || rawCookies.length === 0) return;

    const cookies = rawCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expirationDate === 'number' ? Math.round(c.expirationDate) : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: toPlaywrightSameSite(c.sameSite),
    }));

    const url = `${API_CONFIG.collectorUrl}/sessions/${encodeURIComponent(sessionId)}/environment-bundle`;
    const doPost = () =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${globalAuthState.token}`,
        },
        // Top-level `cookies` marks this as the HttpOnly-authoritative write.
        body: JSON.stringify({ sessionId, cookies, source: 'extension' }),
      });

    // The collector session is created by the collector-script's ASYNC /init
    // handshake — at recording start this upload can race it and get a 404
    // ("session not found YET"). Retry 404s with backoff until the session
    // exists instead of silently dropping the HttpOnly cookies. Any other
    // failure (401/5xx/network) gets a single retry and a loud warning, so
    // `hasExtensionCookies:false` is never silent.
    const RETRY_DELAYS_404_MS = [500, 1000, 2000, 4000];
    let attempt = 0;
    let extraRetryUsed = false;
    for (;;) {
      attempt += 1;
      let status = null;
      let failure = null;
      try {
        const res = await doPost();
        if (res.ok) return;
        status = res.status;
        failure = `HTTP ${res.status}`;
      } catch (e) {
        failure = `network error: ${e?.message || e}`;
      }

      const is404 = status === 404;
      const delay = is404 ? RETRY_DELAYS_404_MS[attempt - 1] : !extraRetryUsed ? 750 : undefined;
      if (delay === undefined) {
        console.warn(
          `[Voidr] Environment-bundle cookie upload FAILED for session ${sessionId} (${failure}) — ` +
            'HttpOnly cookies will be missing from the session bundle (hasExtensionCookies stays false).',
        );
        return;
      }
      if (!is404) extraRetryUsed = true;
      console.warn(
        `[Voidr] Environment-bundle cookie upload attempt ${attempt} failed (${failure}) — retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } catch (e) {
    console.warn('[Voidr] captureAndUploadCookies failed', e?.message || e);
  }
}

// ── CSP bypass per recording tab ─────────────────────────────────────────────
// Strict CSP `connect-src` on auth providers (e.g. Microsoft B2C used by Blip)
// blocks the collector from POSTing events to collector.voidr.co. We use
// declarativeNetRequest session rules scoped to a specific tabId to remove the
// Content-Security-Policy response header while a recording is active on that
// tab. The rule is added on recording start and removed on stop/tab close.

const CSP_BYPASS_RULE_BASE = 100000;

function cspBypassRuleIdForTab(tabId) {
  return CSP_BYPASS_RULE_BASE + tabId;
}

async function enableCspBypassForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return false;
  if (!chrome.declarativeNetRequest?.updateSessionRules) return false;
  const ruleId = cspBypassRuleIdForTab(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'content-security-policy', operation: 'remove' },
              { header: 'content-security-policy-report-only', operation: 'remove' },
            ],
          },
          condition: {
            tabIds: [tabId],
            resourceTypes: ['main_frame', 'sub_frame'],
          },
        },
      ],
    });
    return true;
  } catch (e) {
    console.error('[Voidr] enableCspBypassForTab failed', tabId, e?.message || e);
    return false;
  }
}

async function disableCspBypassForTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return false;
  if (!chrome.declarativeNetRequest?.updateSessionRules) return false;
  const ruleId = cspBypassRuleIdForTab(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    return true;
  } catch (e) {
    console.error('[Voidr] disableCspBypassForTab failed', tabId, e?.message || e);
    return false;
  }
}

async function disableAllCspBypassRules() {
  if (!chrome.declarativeNetRequest?.getSessionRules) return;
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules
      .map((r) => r.id)
      .filter((id) => id >= CSP_BYPASS_RULE_BASE && id < CSP_BYPASS_RULE_BASE + 1_000_000);
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
  } catch (e) {
    console.error('[Voidr] disableAllCspBypassRules failed', e?.message || e);
  }
}

async function enableCspBypassForRecording(recording) {
  if (!recording) return;
  const ids = recording.trackedTabIds || [];
  for (const tabId of ids) {
    await enableCspBypassForTab(tabId);
  }
}

async function injectCollectorInTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['vendor/recorder.min.js'],
  });
}

async function initializeCollectorInTab(tabId, initOptions) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (opts) => {
      try {
        if (!window.VoidrCollector?.init) {
          throw new Error('Collector init API is unavailable');
        }
        await window.VoidrCollector.init(opts);
        const sessionId = window.VoidrCollector.getSessionId?.() || null;
        let authenticatedSessionId = null;
        let hasAuthenticatedSession = false;
        try {
          authenticatedSessionId = window.sessionStorage.getItem('voidr_session_id');
          hasAuthenticatedSession = Boolean(window.sessionStorage.getItem('voidr_jwt'));
        } catch (_) {}
        return {
          ready:
            Boolean(sessionId) && hasAuthenticatedSession && authenticatedSessionId === sessionId,
          sessionId,
        };
      } catch (e) {
        console.error('[Voidr] Collector init error', e);
        throw e;
      }
    },
    args: [initOptions],
  });
  const readiness = results?.[0]?.result;
  if (!VoidrRecordingLifecycle.isCollectorReadinessConfirmed(readiness)) {
    throw new Error('Collector did not confirm an authenticated recording session');
  }
  return readiness.sessionId;
}

async function readCollectorSessionId(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          const liveSessionId = window.VoidrCollector?.getSessionId?.() || null;
          const storedSessionId = window.sessionStorage.getItem('voidr_session_id');
          const hasAuthenticatedSession = Boolean(window.sessionStorage.getItem('voidr_jwt'));
          return liveSessionId || (hasAuthenticatedSession ? storedSessionId : null) || null;
        } catch (_) {
          return null;
        }
      },
    });
    return (res && res[0] && res[0].result) || null;
  } catch (_) {
    return null;
  }
}

// Preserve upstream takeover semantics when the target app embeds its own
// collector. Clear stale session credentials before extension initialization,
// then guard against a late native bundle replacing the extension instance.
async function teardownExistingCollectorInTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const wipe = () => {
          for (const key of [
            'voidr_jwt',
            'voidr_session_id',
            'voidr_user_id',
            'voidr_last_activity',
          ]) {
            try {
              sessionStorage.removeItem(key);
            } catch (_) {}
          }
        };
        try {
          const existing = window.VoidrCollector;
          if (typeof existing?.endSession === 'function') existing.endSession();
          try {
            delete window.VoidrCollector;
          } catch (_) {
            window.VoidrCollector = undefined;
          }
        } finally {
          wipe();
        }
      },
    });
  } catch (_) {}
}

async function armCollectorTakeoverWatchdog(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (!window.VoidrCollector) return;
        window.__voidrExtCollector = window.VoidrCollector;
        const check = () => {
          const current = window.VoidrCollector;
          if (!current || current === window.__voidrExtCollector) return;
          try {
            current.endSession?.();
          } catch (_) {}
          window.VoidrCollector = window.__voidrExtCollector;
        };
        setTimeout(check, 4000);
        setTimeout(check, 12000);
      },
    });
  } catch (_) {}
}

// O manifest declarava js E css juntos; executeScript injeta so o js. Sem o css
// o painel e montado no DOM mas fica sem position/z-index/fundo — invisivel, e
// sem nenhum erro, porque do ponto de vista do JS deu tudo certo.
// Diagnostico do erro de acesso: sem isso "Cannot access contents of the page"
// nao diz QUAL aba nem quais origens estao concedidas, e cada rodada custa um
// ciclo de teste so para descobrir onde olhar.
async function contextoDeAcesso(tabId) {
  let url = '(desconhecida)';
  try {
    const t = await chrome.tabs.get(tabId);
    url = t?.url || '(oculta — sem permissao)';
  } catch (e) {
    url = '(tabs.get falhou: ' + (e?.message || e) + ')';
  }
  let origins = [];
  try {
    origins = (await chrome.permissions.getAll()).origins || [];
  } catch (_) {}
  return `aba=${tabId} url=${url} origens=${JSON.stringify(origins)}`;
}

async function ensureContentCss(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
  } catch (e) {
    console.error('[Voidr] falha ao injetar content.css —', e?.message || e);
  }
}

// A final chunk can spend several seconds in anonymization + local/cloud
// storage before its ACK returns. Keep this inside the UI's 25s stop budget
// without racing a seal that is already durably completing.
const COLLECTOR_TAB_STOP_TIMEOUT_MS = 15000;
const COLLECTOR_FINALIZE_TIMEOUT_MS = 5000;
const COOKIE_UPLOAD_TIMEOUT_MS = 3000;

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = 'COLLECTOR_STOP_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function quiesceCollectorInTab(tabId) {
  const execution = chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (deadlineMs) => {
      const collector = window.VoidrCollector;
      if (!collector) {
        return {
          ok: true,
          flushed: true,
          unavailable: true,
          legacy: true,
          finalChunkSeq: null,
        };
      }
      if (typeof collector.stopAndFlush === 'function') {
        return await collector.stopAndFlush({ deadlineMs });
      }

      // Compatibility with pre-barrier collectors. Their endSession() starts
      // the final keepalive chunk/beacon before returning. We never directly
      // seal from inside this page; the background waits for every legacy tab
      // to quiesce and a settle window before issuing one authoritative seal.
      if (typeof collector.endSession !== 'function') {
        throw new Error('Collector stop API is unavailable');
      }
      const legacyResult = await collector.endSession();
      return {
        ok: legacyResult?.sealed !== false,
        // Legacy collectors provide no awaited chunk ACK. Keep this explicitly
        // unconfirmed until finalize derives a durable server watermark.
        flushed: legacyResult?.flushed === true,
        confirmed: false,
        legacy: true,
        finalChunkSeq: legacyResult?.finalChunkSeq ?? null,
        error: legacyResult?.error || null,
      };
    },
    args: [COLLECTOR_TAB_STOP_TIMEOUT_MS - 500],
  });
  const result = await withTimeout(
    execution,
    COLLECTOR_TAB_STOP_TIMEOUT_MS,
    `Collector stop timed out after ${COLLECTOR_TAB_STOP_TIMEOUT_MS}ms`,
  );
  const stopResult = result?.[0]?.result;
  if (
    !stopResult ||
    stopResult.ok !== true ||
    (!stopResult.legacy && !stopResult.unavailable && stopResult.flushed !== true)
  ) {
    throw new Error(stopResult?.error || 'Collector did not acknowledge its final chunk');
  }
  return stopResult;
}

async function finalizeSessionDirect(
  sessionId,
  initOptions = {},
  { reason = null, finalizedThrough = null } = {},
) {
  const apiKey = initOptions.apiKey;
  if (!apiKey) throw new Error('Direct finalize fallback has no collector apiKey');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COLLECTOR_FINALIZE_TIMEOUT_MS);
  try {
    const collectorUrl = initOptions.collectorUrl || API_CONFIG.collectorUrl;
    const body = {
      apiKey,
      sessionId,
      endedAt: Date.now(),
      finalizationMode: 'explicit-stop',
    };
    if (Number.isInteger(finalizedThrough) && finalizedThrough >= 0) {
      body.finalizedThrough = finalizedThrough;
      body.finalChunkSeq = finalizedThrough;
    }
    const res = await fetch(`${collectorUrl}/sessions/${encodeURIComponent(sessionId)}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Direct finalize failed (HTTP ${res.status})`);
    const seal = await res.json();
    if (seal?.sealed !== true) throw new Error('Direct finalize returned no durable seal');
    return {
      ...seal,
      sessionId,
      degraded: Boolean(reason),
      error: reason,
      fallback: reason ? 'compatibility' : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function attachLoopTestSession(sessionId, loopTest, lifecycleGeneration) {
  if (!loopTest?.scenarioId) return null;
  return VoidrLoopBootstrap.attachSessionWithCapability({
    capabilityStore: loopCapabilitySecrets,
    lifecycleGeneration,
    scenarioId: loopTest.scenarioId,
    sessionId,
    endpoint: `${API_CONFIG.baseUrl}/loop-test/scenarios/${encodeURIComponent(loopTest.scenarioId)}/sessions`,
    fetchImpl: fetch,
  });
}

async function linkOnboardingSessions(recording, sessionIds) {
  const code = recording?.code || recording?.initOptions?.meta?.code || null;
  if (!code || !globalAuthState.token) return { code, confirmed: false };

  let confirmed = false;
  for (const sessionId of sessionIds) {
    try {
      const res = await fetch(
        `${API_CONFIG.baseUrl}/onboarding/recording-sessions/code/${encodeURIComponent(code)}/sessions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${globalAuthState.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ collectorSessionId: sessionId }),
        },
      );
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success && Array.isArray(json?.data?.sessions)) {
        confirmed = json.data.sessions.includes(sessionId) || confirmed;
      }
    } catch (_) {}
  }
  return { code, confirmed };
}

async function sendResumeRecordingUi(tabId, recording, { showCountdown = false } = {}) {
  const stopCapability = await stopCapabilitySecrets.issue(
    recording.lifecycleGeneration,
    tabId,
    recording.canonicalSessionId,
  );
  const payload = {
    action: 'voidr:resumeRecordingUI',
    testCaseName: recording.testCaseName,
    mode: recording.mode,
    onboardingRunId: recording.onboardingRunId,
    evidence: recording.evidence || null,
    loopTest: recording.loopTest || null,
    verification: recording.initOptions?.meta?.verification || null,
    flows: recording.flows,
    applicationId: recording.initOptions?.applicationId || null,
    lifecycleGeneration: recording.lifecycleGeneration,
    stopCapability,
    showCountdown,
  };

  await ensureContentCss(tabId);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, payload);
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['shared/voidr-design-system.css', 'content/content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'background/session-stop-helpers.js',
        'assets/lucide-icons.js',
        'shared/recording-signal-helpers.js',
        'shared/live-evidence-inspector.js',
        'shared/verification-handoff-ux.js',
        'content/content.js',
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await chrome.tabs.sendMessage(tabId, payload);
    return true;
  } catch (error) {
    lastError = error;
  }
  console.warn('[Voidr] Recording UI receiver unavailable after navigation', {
    tabId,
    error: lastError?.message || String(lastError),
  });
  return false;
}

async function cleanupFailedRecordingBootstrap(startupToken, fallbackTabId) {
  const stopping = await updateActiveRecordingForGeneration(
    startupToken.generation,
    (recording) => ({ ...recording, lifecycle: 'stopping' }),
    ['starting', 'recording'],
  );
  if (!stopping) return false;

  const cleanupToken = VoidrRecordingLifecycle.lifecycleToken(stopping);
  return clearActiveRecordingIfCurrent(cleanupToken, async (recording) => {
    await VoidrRecordingLifecycle.cleanupFailedCollectorBootstrap({
      tabId: fallbackTabId,
      trackedTabIds: recording.trackedTabIds,
      disableCsp: disableCspBypassForTab,
      clearActive: async () => {},
    });
  });
}

async function resumeActiveRecordingInTab(tabId) {
  const recording = await hydrateActiveRecording();
  if (!recording || recording.lifecycle === 'stopping') return false;
  const lifecycleToken = VoidrRecordingLifecycle.lifecycleToken(recording);
  if (!lifecycleToken) return false;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !isHttpUrl(tab.url)) return false;

  await ensureTargetContentScript(tabId);
  const resumed = await VoidrRecordingLifecycle.resumeCollectorWithLifecycleChecks({
    token: lifecycleToken,
    isCurrent: (token) => isActiveLifecycleGenerationCurrent(token),
    runIfCurrent: (token, operation) => runWithActiveLifecycleGeneration(token, operation),
    fetchCollector: async () => null,
    injectCollector: async () => {
      await teardownExistingCollectorInTab(tabId);
      return injectCollectorInTab(tabId);
    },
    initializeCollector: async () => {
      const sessionId = await initializeCollectorInTab(tabId, recording.initOptions);
      await armCollectorTakeoverWatchdog(tabId);
      return sessionId;
    },
  });
  if (!resumed.resumed) return false;

  const attached = await attachTrackedRecordingTab(tabId, {
    makeCurrent: true,
    expectedToken: lifecycleToken,
  });
  if (!attached) return false;
  const attachedToken = VoidrRecordingLifecycle.lifecycleToken(attached);
  const ready = await updateActiveRecordingForGeneration(
    attachedToken.generation,
    (current) => VoidrRecordingLifecycle.markRecordingReady(current, resumed.sessionId),
    ['starting', 'recording'],
  );
  if (!ready) return false;
  await sendResumeRecordingUi(tabId, ready);

  return true;
}

// Hydrate auth state whenever the service worker starts up
// MV3 service workers are ephemeral; don't rely on in-memory state
checkAuthenticationStatus();
loopCapabilitySecrets.purgeExpired().catch(() => {});
hydrateActiveRecording().then((recording) => {
  // Re-apply CSP bypass rules for any active recording so the rule survives
  // a service worker restart mid-recording.
  if (recording) enableCspBypassForRecording(recording);
});

// Also re-check on browser startup
chrome.runtime.onStartup.addListener(() => {
  checkAuthenticationStatus();
  // On a fresh browser session there can't be active recordings yet, but
  // clear any stale dNR rules just in case.
  disableAllCspBypassRules();
  hydrateActiveRecording(true);
});

// Listener para instalação da extensão
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Voidr Testing Assistant instalado:', details.reason);

  // Configurações iniciais
  chrome.storage.sync.set({
    voidrSettings: {
      widgetEnabled: true,
      apiEndpoint: API_CONFIG.baseUrl,
      theme: 'dark',
    },
  });

  // Verifica autenticação na instalação
  checkAuthenticationStatus();
});

// Keep global auth state in sync with storage updates
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.voidrAuth) {
    const newAuth = changes.voidrAuth.newValue;
    if (newAuth && newAuth.token && newAuth.expiresAt > Date.now()) {
      globalAuthState = {
        isAuthenticated: true,
        user: newAuth.user || null,
        token: newAuth.token,
      };
      console.log('Auth state synced from storage change');
    } else {
      globalAuthState = { isAuthenticated: false, user: null, token: null };
      console.log('Auth cleared due to storage change');
    }
  }

  if (changes[ACTIVE_RECORDING_STORAGE_KEY]) {
    activeRecording = normalizeActiveRecording(changes[ACTIVE_RECORDING_STORAGE_KEY].newValue);
  }
});

// Verifica status de autenticação
async function checkAuthenticationStatus() {
  try {
    const result = await chrome.storage.local.get(['voidrAuth']);
    const authData = result.voidrAuth;

    if (authData && authData.token && authData.expiresAt > Date.now()) {
      // Valida o token antes de considerar autenticado
      const isValid = await validateTokenInBackground(authData.token);

      if (isValid && isValid.user) {
        globalAuthState = {
          isAuthenticated: true,
          user: isValid.user,
          token: authData.token,
        };
        console.log('User is authenticated:', isValid.user?.email);
      } else {
        console.log('Stored token is invalid, clearing...');
        await chrome.storage.local.remove(['voidrAuth']);
        globalAuthState = {
          isAuthenticated: false,
          user: null,
          token: null,
        };
      }
    } else {
      if (authData && authData.expiresAt <= Date.now()) {
        console.log('Token expired, clearing...');
        await chrome.storage.local.remove(['voidrAuth']);
      }

      globalAuthState = {
        isAuthenticated: false,
        user: null,
        token: null,
      };
      console.log('User is not authenticated');
    }
  } catch (error) {
    console.error('Error checking authentication:', error);
    globalAuthState = {
      isAuthenticated: false,
      user: null,
      token: null,
    };
  }
}

function reloadTabAndWaitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (_) {}
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId, { bypassCache: false }, () => {
      void chrome.runtime.lastError;
    });
  });
}

// A document loaded BEFORE the CSP-bypass rule existed keeps its original CSP:
// every collector request (init/chunks/bundle) is silently blocked and the
// recording "runs" but nothing is saved. declarativeNetRequest only strips
// headers on future navigations, so those tabs need one reload. A CSP-blocked
// fetch rejects immediately even in no-cors mode, which makes a cheap probe.
// Sem <all_urls> no manifest, o content script nao volta sozinho depois que a
// aba recarrega (e o fluxo de gravacao recarrega, para dropar o CSP). Sem ele a
// barra de gravacao some — e o Stop junto — enquanto o collector segue gravando.
// Registrar dinamicamente para o dominio concedido devolve esse comportamento
// sem reabrir acesso a todos os sites.
const ID_CS_ALVO = 'voidr-target-content';

async function ensureTargetContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || !/^https?:/i.test(tab.url)) return;
    const matches = [new URL(tab.url).origin + '/*'];
    const cfg = {
      id: ID_CS_ALVO,
      matches,
      js: [
        'shared/loop-bootstrap-helpers.js',
        'content/bootstrap.js',
        'background/session-stop-helpers.js',
        'assets/lucide-icons.js',
        'shared/recording-signal-helpers.js',
        'shared/live-evidence-inspector.js',
        'shared/verification-handoff-ux.js',
        'content/content.js',
      ],
      css: ['shared/voidr-design-system.css', 'content/content.css'],
      runAt: 'document_end',
      persistAcrossSessions: false,
    };
    const jaTem = await chrome.scripting
      .getRegisteredContentScripts({ ids: [ID_CS_ALVO] })
      .catch(() => []);
    if (jaTem.length) await chrome.scripting.updateContentScripts([cfg]);
    else await chrome.scripting.registerContentScripts([cfg]);
    console.log('[Voidr] content script registrado para', matches[0]);
  } catch (e) {
    console.error('[Voidr] falha ao registrar content script no alvo', e?.message || e);
  }
}

async function tabBlocksCollectorConnects(tabId, collectorUrl) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (url) => {
        try {
          await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
          return false;
        } catch (_) {
          return true;
        }
      },
      args: [collectorUrl],
    });
    return Boolean(res && res[0] && res[0].result);
  } catch (_) {
    return false;
  }
}

const VERIFICATION_CAPABILITY_PREFIX = 'voidrVerificationCapability:';
const VERIFICATION_EVIDENCE_PREFIX = 'voidrVerificationEvidence:';
const VERIFICATION_VOICE_PREFIX = 'voidrVerificationVoice:';
const ACTIVE_VERIFICATION_VOICE_KEY = 'voidrActiveVerificationVoice';
let offscreenVoiceDocumentPromise = null;

function verificationCapabilityKey(verificationId, generation) {
  return `${VERIFICATION_CAPABILITY_PREFIX}${verificationId}:${generation}`;
}

async function readVerificationCapability(verificationId, generation) {
  const key = verificationCapabilityKey(verificationId, generation);
  const value = await chrome.storage.session.get([key]);
  const record = value[key];
  if (
    !record ||
    record.verificationId !== verificationId ||
    record.generation !== generation ||
    typeof record.token !== 'string' ||
    new Date(record.expiresAt).getTime() <= Date.now()
  ) {
    await chrome.storage.session.remove([key]);
    return null;
  }
  return { key, record };
}

async function persistVerificationCapability(record) {
  const key = verificationCapabilityKey(record.verificationId, record.generation);
  await chrome.storage.session.set({ [key]: record });
  return key;
}

async function verificationIngest(record, endpoint, body) {
  const response = await fetch(
    `${API_CONFIG.baseUrl}/verification-ingest/verifications/${encodeURIComponent(record.verificationId)}/${endpoint}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${record.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      json?.message || json?.error || `Verification ingest failed (${response.status})`,
    );
  }
  const data = json?.data || json;
  const lifecycleVersion = Number(data?.lifecycleVersion ?? data?.verification?.lifecycleVersion);
  if (Number.isInteger(lifecycleVersion)) {
    record.lifecycleVersion = lifecycleVersion;
    await persistVerificationCapability(record);
  }
  return data;
}

async function ensureOffscreenVoiceDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenVoiceDocumentPromise) {
    offscreenVoiceDocumentPromise = chrome.offscreen
      .createDocument({
        url: 'offscreen/voice.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture optional microphone notes while a Voidr Loop is recording.',
      })
      .finally(() => {
        offscreenVoiceDocumentPromise = null;
      });
  }
  await offscreenVoiceDocumentPromise;
}

async function notifyVerificationVoice(tabId, state) {
  if (!Number.isInteger(tabId)) return;
  await chrome.tabs
    .sendMessage(tabId, { action: 'voidr:verificationVoiceStatus', ...state })
    .catch(() => undefined);
}

async function persistVerificationVoiceSegment(message) {
  const found = await readVerificationCapability(message.verificationId, message.generation);
  if (!found) throw new Error('Verification capability is expired or revoked');
  const segmentId = message.segment?.segmentId;
  if (!segmentId || message.segment?.generation !== message.generation) {
    throw new Error('Voice segment coordinates are invalid');
  }
  const key = `${VERIFICATION_VOICE_PREFIX}${message.verificationId}:${message.generation}:${segmentId}`;
  await chrome.storage.local.set({
    [key]: {
      verificationId: message.verificationId,
      generation: message.generation,
      tabId: message.tabId,
      segment: message.segment,
      capturedAt: Date.now(),
      adapter: 'local-extension-outbox',
    },
  });
  try {
    const uploaded = await verificationIngest(found.record, 'voice-segments', message.segment);
    await chrome.storage.local.remove([key]);
    await notifyVerificationVoice(message.tabId, {
      state: 'listening',
      transcript: uploaded?.segment?.text || '',
      segmentId,
    });
    return uploaded;
  } catch (error) {
    await chrome.storage.local.set({
      [key]: {
        verificationId: message.verificationId,
        generation: message.generation,
        tabId: message.tabId,
        segment: message.segment,
        capturedAt: Date.now(),
        adapter: 'local-extension-outbox',
        lastAttemptAt: Date.now(),
        uploadError: error?.message || String(error),
      },
    });
    await notifyVerificationVoice(message.tabId, { state: 'queued' });
    throw error;
  }
}

async function flushPendingVerificationVoice(record) {
  const stored = await chrome.storage.local.get(null);
  const entries = Object.entries(stored).filter(
    ([key, value]) =>
      key.startsWith(VERIFICATION_VOICE_PREFIX) &&
      value?.verificationId === record.verificationId &&
      value?.generation === record.generation,
  );
  for (const [key, value] of entries) {
    const uploaded = await verificationIngest(record, 'voice-segments', value.segment);
    await chrome.storage.local.remove([key]);
    await notifyVerificationVoice(value.tabId, {
      state: 'listening',
      transcript: uploaded?.segment?.text || '',
      segmentId: value.segment?.segmentId,
    });
  }
  return entries.length;
}

async function queueVerificationIngest(record, endpoint, input, idempotencyKey) {
  const pending = Array.isArray(record.pending) ? record.pending : [];
  if (!pending.some((entry) => entry.idempotencyKey === idempotencyKey)) {
    pending.push({ endpoint, input, idempotencyKey, queuedAt: Date.now() });
  }
  record.pending = pending.slice(-50);
  await persistVerificationCapability(record);
}

async function reconcilePendingVerificationEvidence(record) {
  const stored = await chrome.storage.local.get(null);
  const candidates = Object.entries(stored).filter(
    ([key, value]) =>
      key.startsWith(VERIFICATION_EVIDENCE_PREFIX) &&
      value?.verificationId === record.verificationId &&
      value?.generation === record.generation,
  );
  for (const [key, value] of candidates) {
    const evidenceId = key.slice(VERIFICATION_EVIDENCE_PREFIX.length);
    const legacyRefs = [
      `verification-evidence-local:${evidenceId}`,
      `verification-crop-local:${evidenceId}`,
    ];
    const localRef =
      value.localRef ||
      legacyRefs.find((candidate) =>
        (record.pending || []).some(
          (entry) => entry.input?.screenshotRef === candidate || entry.input?.cropRef === candidate,
        ),
      ) ||
      legacyRefs[0];
    if (!VoidrVerificationEvidence.isLocalEvidenceRef(localRef)) {
      throw new Error('Pending Verification evidence has an invalid local reference');
    }
    const match = /^data:(image\/(?:webp|png|jpeg));base64,(.+)$/s.exec(value.dataUrl || '');
    if (!match) throw new Error('Pending Verification evidence has invalid image data');
    try {
      const uploaded = await verificationIngest(record, 'evidence-assets', {
        generation: record.generation,
        kind:
          value.kind === 'crop' || String(localRef).startsWith('verification-crop-local:')
            ? 'crop'
            : 'screenshot',
        contentType: match[1],
        dataBase64: match[2],
        localRefs: value.localRef ? [value.localRef] : legacyRefs,
      });
      if (!uploaded?.evidenceRef) {
        throw new Error('Verification evidence upload returned no durable reference');
      }
      record.pending = VoidrVerificationEvidence.replacePendingEvidenceRef(
        record.pending,
        localRef,
        uploaded.evidenceRef,
      );
      await persistVerificationCapability(record);
      await chrome.storage.local.remove([key]);
    } catch (error) {
      await chrome.storage.local.set({
        [key]: {
          ...value,
          uploadError: error?.message || String(error),
          lastAttemptAt: Date.now(),
        },
      });
      throw error;
    }
  }
  return candidates.length;
}

async function flushVerificationIngestQueue(record) {
  const pending = Array.isArray(record.pending) ? [...record.pending] : [];
  if (pending.some((entry) => VoidrVerificationEvidence.hasLocalEvidenceRefs(entry.input))) {
    throw new Error('Verification evidence is still pending durable upload');
  }
  record.pending = [];
  await persistVerificationCapability(record);
  for (const entry of pending) {
    try {
      await verificationIngest(record, entry.endpoint, {
        ...entry.input,
        lifecycleVersion: record.lifecycleVersion,
        idempotencyKey: entry.idempotencyKey,
      });
    } catch (error) {
      await queueVerificationIngest(record, entry.endpoint, entry.input, entry.idempotencyKey);
      throw error;
    }
  }
  return pending.length;
}

async function waitForCollectorReadiness(sessionId, collectorToken, timeoutMs = 20000) {
  let readToken = collectorToken || globalAuthState.token || null;
  // Local Loops deliberately bypass Auth0, but collector read endpoints still
  // require a short-lived collector JWT. Mint it in memory from the explicit
  // localhost-only key; never persist it in recording/capability state.
  if (!readToken && LOCAL_VERIFICATION_ADAPTER && LOCAL_VERIFICATION_COLLECTOR_KEY) {
    const response = await fetch(`${API_CONFIG.collectorUrl}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: LOCAL_VERIFICATION_COLLECTOR_KEY }),
    });
    if (!response.ok) {
      throw new Error(`Collector local read authorization failed (HTTP ${response.status})`);
    }
    const payload = await response.json();
    readToken = payload?.token || payload?.data?.token || payload?.data?.data?.token || null;
    if (!readToken) throw new Error('Collector local read authorization returned no token');
  }
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${API_CONFIG.collectorUrl}/sessions/${encodeURIComponent(sessionId)}/ensure-indexed`,
      {
        method: 'POST',
        headers: {
          ...(readToken ? { Authorization: `Bearer ${readToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ budgetMs: 1500 }),
      },
    );
    last = await response.json().catch(() => null);
    if (response.ok && ['ready', 'indexed'].includes(last?.status)) return last;
    if (response.status === 409 && last?.status === 'failed') {
      throw new Error(last?.lastError || 'Collector indexing failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Collector readiness timed out${last?.status ? ` (${last.status})` : ''}`);
}

const VERIFICATION_RETRY_ALARM_PREFIX = 'voidrVerificationSealRetry:';

function safeVerificationCoordinates(recording) {
  const verification =
    recording?.initOptions?.verification || recording?.initOptions?.meta?.verification || null;
  if (!verification?.verificationId || !verification?.generation) return null;
  return {
    verificationId: verification.verificationId,
    generation: verification.generation,
    bindingId: verification.bindingId || null,
    loopId: verification.loopId || recording?.loopTest?.scenarioId || null,
    cycleId:
      verification.cycleId || verification.verificationId || recording?.loopTest?.cycleId || null,
    cycleNumber: verification.cycleNumber || recording?.loopTest?.cycleNumber || null,
  };
}

function loopFinalizationStateFromVerification(verification, fallback = 'context') {
  const deliveryState = verification?.harnessDelivery?.state;
  if (['available', 'acknowledged', 'failed'].includes(deliveryState)) return deliveryState;
  if (
    !verification?.harness &&
    ['artifact_ready', 'diagnosing', 'decision_required', 'open', 'confirmed'].includes(
      verification?.status,
    )
  ) {
    return 'product_ready';
  }
  return fallback;
}

async function persistLoopFinalization(coordinates, patch = {}) {
  if (!coordinates?.verificationId || !coordinates?.generation) return null;
  let previous = null;
  try {
    const stored = await chrome.storage.session.get([LOOP_FINALIZATION_STORAGE_KEY]);
    previous = stored[LOOP_FINALIZATION_STORAGE_KEY] || null;
  } catch (_) {}
  const sameRun =
    previous?.verificationId === coordinates.verificationId &&
    previous?.generation === coordinates.generation;
  const next = {
    ...(sameRun ? previous : {}),
    verificationId: coordinates.verificationId,
    generation: coordinates.generation,
    loopId: coordinates.loopId || previous?.loopId || null,
    cycleId: coordinates.cycleId || previous?.cycleId || coordinates.verificationId,
    cycleNumber: coordinates.cycleNumber || previous?.cycleNumber || null,
    state: patch.state || (sameRun ? previous?.state : null) || 'stopping',
    harness: patch.harness === undefined ? previous?.harness || null : patch.harness,
    harnessDelivery:
      patch.harnessDelivery === undefined
        ? previous?.harnessDelivery || null
        : patch.harnessDelivery,
    error: patch.error === undefined ? previous?.error || null : patch.error,
    sessionId: patch.sessionId || previous?.sessionId || null,
    updatedAt: Date.now(),
  };
  await chrome.storage.session.set({ [LOOP_FINALIZATION_STORAGE_KEY]: next });
  try {
    chrome.runtime.sendMessage({ action: 'voidr:loopFinalizationUpdated', finalization: next });
  } catch (_) {}
  return next;
}

async function readLoopFinalization(verificationId, generation) {
  try {
    const stored = await chrome.storage.session.get([LOOP_FINALIZATION_STORAGE_KEY]);
    const finalization = stored[LOOP_FINALIZATION_STORAGE_KEY];
    if (
      finalization?.verificationId === verificationId &&
      finalization?.generation === generation
    ) {
      return finalization;
    }
  } catch (_) {}
  return null;
}

async function stageVerificationSeal(record, coordinates, stopResult) {
  const sessionId = stopResult?.sessionId;
  if (!sessionId) throw new Error('Verification stop did not return a sessionId');
  const finalizations = stopResult?.finalizations || {};
  const finalization =
    finalizations[sessionId] ||
    Object.values(finalizations).find((item) => item?.sessionId === sessionId) ||
    {};
  const sealedThrough = Number(
    finalization.sealedThrough ?? finalization.finalizedThrough ?? stopResult?.finalChunkSeq,
  );
  if (!Number.isInteger(sealedThrough) || sealedThrough < 1) {
    throw new Error('Collector seal did not expose a durable watermark');
  }
  record.pendingSeal = {
    sessionId,
    sealedThrough,
    idempotencyKey: `seal:${coordinates.generation}:${sessionId}:${sealedThrough}`,
    receivedAt: Date.now(),
  };
  record.loopFinalization = coordinates;
  await persistVerificationCapability(record);
  await persistLoopFinalization(coordinates, {
    state: 'sealing',
    sessionId,
    error: null,
  });
  return record.pendingSeal;
}

function verificationRetryAlarmName(verificationId, generation) {
  return `${VERIFICATION_RETRY_ALARM_PREFIX}${verificationId}:${generation}`;
}

async function attemptPendingVerificationSeal(record, timeoutMs = 20000) {
  const pending = record.pendingSeal;
  if (
    !pending?.sessionId ||
    !Number.isInteger(pending.sealedThrough) ||
    pending.sealedThrough < 1
  ) {
    throw new Error('Pending Verification seal receipt is incomplete');
  }
  await flushPendingVerificationVoice(record);
  await reconcilePendingVerificationEvidence(record);
  await flushVerificationIngestQueue(record);
  if (!globalAuthState.token) {
    await checkAuthenticationStatus();
  }
  const readiness = await waitForCollectorReadiness(pending.sessionId, undefined, timeoutMs);
  const indexedThrough = Number(
    readiness?.readinessToken?.indexedThrough ?? readiness?.indexedThrough,
  );
  if (!Number.isInteger(indexedThrough) || indexedThrough < pending.sealedThrough) {
    throw new Error('Collector readiness is behind the durable seal');
  }
  const data = await verificationIngest(record, 'seal', {
    lifecycleVersion: record.lifecycleVersion,
    idempotencyKey:
      pending.idempotencyKey ||
      `seal:${record.generation}:${pending.sessionId}:${pending.sealedThrough}`,
    sessionId: pending.sessionId,
    watermark: {
      acceptedSequence: pending.sealedThrough,
      durableSequence: pending.sealedThrough,
      derivedSequence: indexedThrough,
    },
  });
  record.pendingSeal = null;
  await persistLoopFinalization(record.loopFinalization, {
    state: 'context',
    sessionId: pending.sessionId,
    error: null,
  });
  const key = verificationCapabilityKey(record.verificationId, record.generation);
  await chrome.storage.session.remove([key]);
  await chrome.alarms.clear(verificationRetryAlarmName(record.verificationId, record.generation));
  return { data, readiness };
}

async function waitForVerificationHandoffStatus(verificationId, timeoutMs = 12000) {
  if (!LOCAL_VERIFICATION_ADAPTER) return null;
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${API_CONFIG.baseUrl}/verification-dev/verifications/${encodeURIComponent(verificationId)}/status`,
      {
        headers: {
          'x-voidr-dev-key': LOCAL_VERIFICATION_KEY,
          'x-voidr-organization-id': LOCAL_VERIFICATION_ORGANIZATION,
        },
      },
    );
    if (response.ok) {
      const body = await response.json().catch(() => null);
      latest = body?.data ?? body;
      const productReady =
        !latest?.harness &&
        [
          'artifact_ready',
          'diagnosing',
          'decision_required',
          'open',
          'confirmed',
          'failed',
        ].includes(latest?.status);
      if (
        productReady ||
        ['available', 'acknowledged', 'failed'].includes(latest?.harnessDelivery?.state)
      ) {
        return latest;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return latest;
}

async function scheduleVerificationSealRetry(record) {
  await persistVerificationCapability(record);
  await chrome.alarms.create(verificationRetryAlarmName(record.verificationId, record.generation), {
    delayInMinutes: 0.1,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name?.startsWith(VERIFICATION_RETRY_ALARM_PREFIX)) return;
  const coordinates = alarm.name.slice(VERIFICATION_RETRY_ALARM_PREFIX.length);
  const splitAt = coordinates.lastIndexOf(':');
  if (splitAt < 1) return;
  const verificationId = coordinates.slice(0, splitAt);
  const generation = coordinates.slice(splitAt + 1);
  void readVerificationCapability(verificationId, generation)
    .then(async (found) => {
      if (!found?.record?.pendingSeal) return;
      try {
        await attemptPendingVerificationSeal(found.record);
        const verification = await waitForVerificationHandoffStatus(verificationId, 12000).catch(
          () => null,
        );
        await persistLoopFinalization(found.record.loopFinalization, {
          state: loopFinalizationStateFromVerification(verification, 'product_ready'),
          harness: verification?.harness || null,
          harnessDelivery: verification?.harnessDelivery || null,
          error: null,
        });
      } catch (error) {
        await persistLoopFinalization(found.record.loopFinalization, {
          state: 'pending',
          error: error?.message || String(error),
        });
        await scheduleVerificationSealRetry(found.record);
      }
    })
    .catch(() => undefined);
});

// Listener para mensagens dos content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'voidr:startVerification':
      (async () => {
        const verification = request.verification;
        const capability = request.capability;
        if (
          !verification?.verificationId ||
          !verification?.generation ||
          !verification?.targetUrl ||
          !capability?.token ||
          !capability?.expiresAt
        ) {
          throw new Error('Verification handoff is incomplete');
        }
        const target = new URL(verification.targetUrl);
        if (!['http:', 'https:'].includes(target.protocol)) {
          throw new Error('Verification target must use HTTP(S)');
        }
        const record = {
          verificationId: verification.verificationId,
          generation: verification.generation,
          bindingId: verification.bindingId,
          token: capability.token,
          expiresAt: capability.expiresAt,
          lifecycleVersion: verification.lifecycleVersion,
          createdAt: Date.now(),
          pending: [],
        };
        await persistVerificationCapability(record);
        const tab = await chrome.tabs.create({ url: target.toString(), active: true });
        if (!Number.isInteger(tab.id)) throw new Error('Unable to open Verification target');
        await new Promise((resolve) => setTimeout(resolve, 900));
        const payload = {
          action: 'voidr:startVerificationRecording',
          verification: {
            verificationId: verification.verificationId,
            generation: verification.generation,
            bindingId: verification.bindingId,
            mission: verification.mission,
            targetUrl: verification.targetUrl,
          },
        };
        try {
          await chrome.tabs.sendMessage(tab.id, payload);
        } catch (_) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content.js'],
          });
          await new Promise((resolve) => setTimeout(resolve, 120));
          await chrome.tabs.sendMessage(tab.id, payload);
        }
        sendResponse({ success: true, tabId: tab.id });
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:startVerificationVoice':
      (async () => {
        const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : request.tabId;
        if (!Number.isInteger(tabId)) throw new Error('Voice capture requires an active tab');
        const found = await readVerificationCapability(request.verificationId, request.generation);
        if (!found) throw new Error('Verification capability is expired or revoked');
        await ensureOffscreenVoiceDocument();
        await chrome.storage.session.set({
          [ACTIVE_VERIFICATION_VOICE_KEY]: {
            verificationId: request.verificationId,
            generation: request.generation,
            tabId,
            startedAt: Date.now(),
          },
        });
        const response = await chrome.runtime.sendMessage({
          action: 'voidr:offscreenStartVoice',
          verificationId: request.verificationId,
          generation: request.generation,
          tabId,
          baseOffsetMs: Math.max(0, Number(request.baseOffsetMs) || 0),
          language: request.language || 'pt-BR',
        });
        if (!response?.success) {
          await chrome.storage.session.remove([ACTIVE_VERIFICATION_VOICE_KEY]);
          throw new Error(response?.error || 'Microphone capture could not start');
        }
        await notifyVerificationVoice(tabId, { state: 'listening' });
        sendResponse({ success: true, state: 'listening' });
      })().catch(async (error) => {
        const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : request.tabId;
        await notifyVerificationVoice(tabId, {
          state: 'unavailable',
          error: error?.message || String(error),
        });
        sendResponse({ success: false, error: error?.message || String(error) });
      });
      return true;

    case 'voidr:stopVerificationVoice':
      (async () => {
        if (await chrome.offscreen.hasDocument()) {
          const stopped = await chrome.runtime.sendMessage({ action: 'voidr:offscreenStopVoice' });
          if (!stopped?.success)
            throw new Error(stopped?.error || 'Microphone capture did not stop');
        }
        const found = await readVerificationCapability(request.verificationId, request.generation);
        if (found) await flushPendingVerificationVoice(found.record);
        await chrome.storage.session.remove([ACTIVE_VERIFICATION_VOICE_KEY]);
        const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : request.tabId;
        await notifyVerificationVoice(tabId, { state: 'stopped' });
        sendResponse({ success: true, state: 'stopped' });
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:voicePcmSegment':
      (async () => {
        if (sender?.url !== chrome.runtime.getURL('offscreen/voice.html')) {
          throw new Error('Voice segments are accepted only from the governed capture document');
        }
        const data = await persistVerificationVoiceSegment(request);
        sendResponse({ success: true, data });
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:verificationIngest':
      (async () => {
        const found = await readVerificationCapability(request.verificationId, request.generation);
        if (!found) throw new Error('Verification capability is expired or revoked');
        const idempotencyKey =
          request.idempotencyKey ||
          `${request.endpoint}:${request.generation}:${crypto.randomUUID()}`;
        const input = request.input || {};
        if (
          request.endpoint === 'annotations' &&
          VoidrVerificationEvidence.hasLocalEvidenceRefs(input)
        ) {
          await queueVerificationIngest(found.record, request.endpoint, input, idempotencyKey);
          sendResponse({ success: true, queued: true, waitingForDurableEvidence: true });
          return;
        }
        try {
          const data = await verificationIngest(found.record, request.endpoint, {
            ...input,
            lifecycleVersion: found.record.lifecycleVersion,
            idempotencyKey,
          });
          sendResponse({ success: true, data });
        } catch (error) {
          if (request.queueWhenOffline === true) {
            await queueVerificationIngest(found.record, request.endpoint, input, idempotencyKey);
            sendResponse({ success: true, queued: true });
            return;
          }
          throw error;
        }
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:flushVerificationQueue':
      (async () => {
        const found = await readVerificationCapability(request.verificationId, request.generation);
        if (!found) throw new Error('Verification capability is expired or revoked');
        await reconcilePendingVerificationEvidence(found.record);
        const flushed = await flushVerificationIngestQueue(found.record);
        sendResponse({ success: true, flushed });
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:captureVerificationEvidence':
      (async () => {
        const dataUrl = await Promise.race([
          chrome.tabs.captureVisibleTab(sender?.tab?.windowId, {
            format: 'png',
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Verification screenshot capture timed out')), 5000),
          ),
        ]);
        const found = await readVerificationCapability(request.verificationId, request.generation);
        if (!found) throw new Error('Verification capability is expired or revoked');
        const match = /^data:(image\/png);base64,(.+)$/s.exec(dataUrl);
        if (!match) throw new Error('Verification screenshot has an invalid media type');
        let ref;
        try {
          const uploaded = await verificationIngest(found.record, 'evidence-assets', {
            generation: request.generation,
            kind: 'screenshot',
            contentType: match[1],
            dataBase64: match[2],
          });
          ref = uploaded.evidenceRef;
        } catch (error) {
          // Offline safety: preserve the bytes locally and allow the text
          // annotation to queue. The cycle is explicitly degraded until a
          // durable asset is available; no screenshot is silently discarded.
          const evidenceId = crypto.randomUUID();
          ref = `verification-evidence-local:${evidenceId}`;
          await chrome.storage.local.set({
            [`voidrVerificationEvidence:${evidenceId}`]: {
              localRef: ref,
              kind: 'screenshot',
              dataUrl,
              verificationId: request.verificationId,
              generation: request.generation,
              rect: request.rect || null,
              capturedAt: Date.now(),
              adapter: 'local-extension-storage',
              uploadError: error?.message || String(error),
            },
          });
        }
        sendResponse({ success: true, ref, dataUrl });
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:storeVerificationCrop':
      (async () => {
        if (typeof request.dataUrl !== 'string' || !request.dataUrl.startsWith('data:image/')) {
          throw new Error('Invalid Verification crop');
        }
        const found = await readVerificationCapability(request.verificationId, request.generation);
        if (!found) throw new Error('Verification capability is expired or revoked');
        const match = /^data:(image\/(?:webp|png|jpeg));base64,(.+)$/s.exec(request.dataUrl);
        if (!match) throw new Error('Invalid Verification crop media type');
        let ref;
        try {
          const uploaded = await verificationIngest(found.record, 'evidence-assets', {
            generation: request.generation,
            kind: 'crop',
            contentType: match[1],
            dataBase64: match[2],
          });
          ref = uploaded.evidenceRef;
        } catch (error) {
          const evidenceId = crypto.randomUUID();
          ref = `verification-crop-local:${evidenceId}`;
          await chrome.storage.local.set({
            [`voidrVerificationEvidence:${evidenceId}`]: {
              localRef: ref,
              kind: 'crop',
              dataUrl: request.dataUrl,
              verificationId: request.verificationId,
              generation: request.generation,
              capturedAt: Date.now(),
              adapter: 'local-extension-storage',
              uploadError: error?.message || String(error),
            },
          });
        }
        sendResponse({ success: true, ref });
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:verificationSeal':
      (async () => {
        const found = await readVerificationCapability(request.verificationId, request.generation);
        const coordinates = {
          verificationId: request.verificationId,
          generation: request.generation,
          loopId: request.verification?.loopId || request.stopResult?.verification?.loopId || null,
          cycleId:
            request.verification?.cycleId ||
            request.stopResult?.verification?.cycleId ||
            request.verificationId,
          cycleNumber:
            request.verification?.cycleNumber ||
            request.stopResult?.verification?.cycleNumber ||
            null,
        };
        if (!found) {
          const stored = await readLoopFinalization(request.verificationId, request.generation);
          if (!stored) throw new Error('Verification capability is expired or revoked');
          const verification = await waitForVerificationHandoffStatus(
            request.verificationId,
            12000,
          ).catch(() => null);
          const state = verification
            ? loopFinalizationStateFromVerification(verification, stored.state)
            : stored.state;
          const finalization = await persistLoopFinalization(coordinates, {
            state,
            harness: verification?.harness,
            harnessDelivery: verification?.harnessDelivery,
            error: null,
          });
          sendResponse({
            success: true,
            verification,
            finalization,
            pending: ['stopping', 'sealing', 'context', 'pending'].includes(state),
            duplicate: true,
          });
          return;
        }
        await stageVerificationSeal(found.record, coordinates, request.stopResult);
        try {
          const result = await attemptPendingVerificationSeal(found.record, 20000);
          const verification = await waitForVerificationHandoffStatus(
            request.verificationId,
            12000,
          ).catch(() => null);
          const state = loopFinalizationStateFromVerification(verification, 'product_ready');
          const finalization = await persistLoopFinalization(coordinates, {
            state,
            harness: verification?.harness || null,
            harnessDelivery: verification?.harnessDelivery || null,
            error: null,
          });
          sendResponse({
            success: true,
            ...result,
            verification,
            finalization,
            pending: false,
          });
        } catch (error) {
          await scheduleVerificationSealRetry(found.record);
          const finalization = await persistLoopFinalization(coordinates, {
            state: 'pending',
            error: error?.message || String(error),
          });
          sendResponse({
            success: true,
            pending: true,
            finalization,
            receipt: {
              sessionId: found.record.pendingSeal?.sessionId,
              sealedThrough: found.record.pendingSeal?.sealedThrough,
              retryScheduled: true,
            },
          });
        }
      })().catch((error) =>
        sendResponse({ success: false, error: error?.message || String(error) }),
      );
      return true;

    case 'voidr:verificationHandoffStatus':
      waitForVerificationHandoffStatus(request.verificationId, 1500)
        .then(async (verification) => {
          let finalization = null;
          if (request.generation) {
            finalization = await persistLoopFinalization(
              {
                verificationId: request.verificationId,
                generation: request.generation,
                loopId: request.loopId,
                cycleId: request.cycleId,
                cycleNumber: request.cycleNumber,
              },
              {
                state: verification
                  ? loopFinalizationStateFromVerification(verification, 'context')
                  : undefined,
                harness: verification?.harness || null,
                harnessDelivery: verification?.harnessDelivery || null,
                error: null,
              },
            );
          }
          sendResponse({ success: true, verification, finalization });
        })
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
      return true;

    case 'voidr:dismissLoopFinalization':
      chrome.storage.session
        .remove([LOOP_FINALIZATION_STORAGE_KEY])
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
      return true;

    case 'voidr:stageLoopDeepLink':
      loopBootstrapStaging
        .stage(sender?.tab?.id, {
          scenarioId: request.scenarioId,
          token: request.token,
          cycleId: request.cycleId,
          transportVersion: request.transportVersion,
        })
        .then((staged) => sendResponse({ success: staged }))
        .catch(() => sendResponse({ success: false }));
      return true;

    case 'voidr:consumeLoopDeepLink':
      loopBootstrapStaging
        .consume(sender?.tab?.id)
        .then((staged) => sendResponse({ staged }))
        .catch(() => sendResponse({ staged: null }));
      return true;

    case 'voidr:getRecordingState':
      getSafeRecordingState()
        .then(sendResponse)
        .catch(() => sendResponse({ active: null, startupFailure: null }));
      return true;

    case 'voidr:loopStartupFailed':
      Promise.all([
        persistLoopStartupFailure(request.reason),
        loopCapabilitySecrets.discardTab(sender?.tab?.id),
      ])
        .then(([failure]) => sendResponse({ success: true, failure }))
        .catch((error) => sendResponse({ success: false, error: error?.message }));
      return true;

    case 'voidr:clearLoopStartupFailure':
      clearLoopStartupFailure()
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error?.message }));
      return true;

    case 'voidr:injectCollectorAndInit':
      (async () => {
        let targetTabId = sender?.tab?.id || lastActiveContentTabId;
        let startupToken = null;
        try {
          // Decide target tab: prefer sender.tab.id, else lastActiveContentTabId, else find an http(s) tab
          if (!targetTabId) {
            try {
              const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
              const focused = wins.find((w) => w.focused);
              const candidates = focused ? [focused, ...wins.filter((w) => w !== focused)] : wins;
              for (const w of candidates) {
                const activeTab = (w.tabs || []).find(
                  (t) => t.active && t.url && /^https?:/i.test(t.url),
                );
                if (activeTab) {
                  targetTabId = activeTab.id;
                  break;
                }
              }
            } catch (_) {}
          }
          if (!targetTabId) {
            sendResponse({ success: false, error: 'No eligible tab for injection' });
            return;
          }

          // Antes de qualquer reload: garante que o content script volte sozinho.
          await ensureTargetContentScript(targetTabId);
          const canonicalSessionId =
            request.initOptions?.forcedSessionId || createRecordingSessionId();
          const initOptions = {
            ...(request.initOptions || {}),
            collectorUrl: API_CONFIG.collectorUrl,
            forcedSessionId: canonicalSessionId,
          };
          const isLoopTest = request.initOptions?.meta?.mode === 'loop-test';
          const isVerification = request.initOptions?.meta?.mode === 'verification';
          const requestedGeneration =
            (isLoopTest || isVerification) && typeof request.lifecycleGeneration === 'string'
              ? request.lifecycleGeneration
              : createLifecycleGeneration();
          if (
            isLoopTest &&
            !(await loopCapabilitySecrets.has(
              requestedGeneration,
              targetTabId,
              request.initOptions?.loopTest?.scenarioId,
            ))
          ) {
            sendResponse({
              success: false,
              error: 'Loop Test recording authorization is unavailable or expired',
            });
            return;
          }

          // Persist intent before the async collector boot. The target can
          // navigate to an identity provider while init is authenticating;
          // onUpdated must already know to resume the same canonical session.
          const startingRecording = await claimActiveRecording({
            tabId: targetTabId,
            currentTabId: targetTabId,
            trackedTabIds: [targetTabId],
            canonicalSessionId,
            initOptions,
            testCaseName: request.initOptions?.meta?.testCase || 'Test Case',
            mode: request.initOptions?.meta?.mode || 'test-case',
            onboardingRunId: request.initOptions?.meta?.onboardingRunId,
            code: request.initOptions?.meta?.code || null,
            evidence: request.initOptions?.meta?.evidence || null,
            loopTest: request.initOptions?.meta?.loopTest || null,
            flows: request.initOptions?.meta?.flows || [],
            sessionIds: [canonicalSessionId],
            startedAt: Date.now(),
            lifecycle: 'starting',
            lifecycleGeneration: requestedGeneration,
            lifecycleVersion: 0,
          });
          if (!startingRecording) {
            if (isLoopTest && activeRecording?.lifecycleGeneration !== requestedGeneration) {
              await loopCapabilitySecrets.discardGeneration(requestedGeneration);
            }
            sendResponse({
              success: false,
              error: 'A recording is already active',
            });
            return;
          }
          startupToken = VoidrRecordingLifecycle.lifecycleToken(startingRecording);

          // Enable CSP only after atomically claiming the active generation.
          // A losing overlapping start must never inject or install a rule.
          await enableCspBypassForTab(targetTabId);
          const reloadedForCsp = await tabBlocksCollectorConnects(
            targetTabId,
            API_CONFIG.collectorUrl,
          );
          if (reloadedForCsp) {
            await reloadTabAndWaitForLoad(targetTabId);
          }

          if (isLoopTest) {
            await clearLoopStartupFailure();
          }

          const resumed = await VoidrRecordingLifecycle.resumeCollectorWithLifecycleChecks({
            token: startupToken,
            isCurrent: (token) => isActiveLifecycleGenerationCurrent(token),
            runIfCurrent: (token, operation) => runWithActiveLifecycleGeneration(token, operation),
            fetchCollector: async () => null,
            injectCollector: async () => {
              await teardownExistingCollectorInTab(targetTabId);
              return injectCollectorInTab(targetTabId);
            },
            initializeCollector: async () => {
              const sessionId = await initializeCollectorInTab(targetTabId, initOptions);
              await armCollectorTakeoverWatchdog(targetTabId);
              return sessionId;
            },
          });
          if (!resumed.resumed) {
            const lifecycleError = new Error('Recording lifecycle changed during startup');
            lifecycleError.code = 'RECORDING_LIFECYCLE_CHANGED';
            throw lifecycleError;
          }

          const readyRecording = await updateActiveRecordingForGeneration(
            startupToken.generation,
            (current) => VoidrRecordingLifecycle.markRecordingReady(current, resumed.sessionId),
            ['starting'],
          );
          if (!readyRecording) {
            const lifecycleError = new Error('Recording lifecycle changed during startup');
            lifecycleError.code = 'RECORDING_LIFECYCLE_CHANGED';
            throw lifecycleError;
          }
          const sessionId = resumed.sessionId;
          if (reloadedForCsp) {
            await sendResumeRecordingUi(targetTabId, readyRecording, { showCountdown: true });
          } else {
            await sendResumeRecordingUi(targetTabId, readyRecording);
          }
          try {
            chrome.runtime
              .sendMessage({
                action: 'voidr:sessionStarted',
                sessionId,
                testCaseName: request.initOptions?.meta?.testCase || null,
                mode: request.initOptions?.meta?.mode || 'test-case',
              })
              .catch(() => {});
          } catch (_) {}
          // Capture HttpOnly cookies (invisible to the page) for the environment
          // bundle when this recording opted in. Best-effort, non-blocking.
          if (request.initOptions?.captureEnvironmentBundle) {
            captureAndUploadCookies(sessionId, request.initOptions?.url);
          }

          // A deep-link launch must land in the recorder state, not in the
          // generic Session Capture home. Open/focus only after the collector
          // is authoritative so popup initialization reads `recording`.
          if (isLoopTest || isVerification) {
            focusExistingAssistantWindow()
              .then((existing) => (existing ? existing : openAssistantWindowAt()))
              .catch(() => {});
          }

          sendResponse({
            success: true,
            lifecycleGeneration: readyRecording.lifecycleGeneration,
            stopCapability: await stopCapabilitySecrets.issue(
              readyRecording.lifecycleGeneration,
              targetTabId,
              readyRecording.canonicalSessionId,
            ),
          });
        } catch (e) {
          console.error('Collector injection error:', e);
          const cleaned = startupToken
            ? await cleanupFailedRecordingBootstrap(startupToken, targetTabId).catch(() => false)
            : false;
          if (
            cleaned &&
            e?.code !== 'RECORDING_LIFECYCLE_CHANGED' &&
            request.initOptions?.meta?.mode === 'loop-test'
          ) {
            await persistLoopStartupFailure(
              'Não foi possível preparar o gravador neste site. Atualize a página e tente novamente.',
            ).catch(() => {});
          }
          sendResponse({ success: false, error: e?.message || 'Unknown error' });
        }
      })();
      return true;
    case 'getSettings':
      chrome.storage.sync.get(['voidrSettings'], (result) => {
        sendResponse(result.voidrSettings || {});
      });
      return true; // Indica resposta assíncrona

    case 'saveSettings':
      chrome.storage.sync.set(
        {
          voidrSettings: request.settings,
        },
        () => {
          sendResponse({ success: true });
        },
      );
      return true;

    case 'getAuthStatus':
      // Garante hidratação do estado antes de responder
      (async () => {
        if (!globalAuthState.token) {
          await checkAuthenticationStatus();
        }
        sendResponse({
          isAuthenticated: globalAuthState.isAuthenticated,
          user: globalAuthState.user,
          token: globalAuthState.token,
        });
      })();
      return true;

    case 'getPlatformUrl':
      sendResponse({ url: API_CONFIG.platformUrl });
      break;

    case 'authCompleted':
      // Atualiza estado global quando auth é concluída
      globalAuthState = {
        isAuthenticated: request.authData.isAuthenticated,
        user: request.authData.user,
        token: request.authData.token,
      };
      console.log('Authentication completed for:', globalAuthState.user?.email);
      sendResponse({ success: true });
      break;

    case 'syncAuthFromPlatformTabs':
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: `${API_CONFIG.platformUrl}/*` });
          for (const tab of tabs) {
            try {
              await syncAuthWithPlatform(tab.id);
              if (globalAuthState.isAuthenticated) break;
            } catch (_) {}
          }
          sendResponse({
            isAuthenticated: globalAuthState.isAuthenticated,
            user: globalAuthState.user,
            token: globalAuthState.token,
          });
        } catch (e) {
          sendResponse({ isAuthenticated: false });
        }
      })();
      return true;

    case 'validateAndStoreToken':
      (async () => {
        try {
          globalAuthState = {
            isAuthenticated: true,
            user: null,
            token: request.token,
          };
          await chrome.storage.local.set({
            voidrAuth: {
              token: request.token,
              user: null,
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
              isAuthenticated: true,
            },
          });

          try {
            const isValid = await validateTokenInBackground(request.token);
            if (isValid?.user) {
              globalAuthState.user = isValid.user;
              await chrome.storage.local.set({
                voidrAuth: {
                  token: request.token,
                  user: isValid.user,
                  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
                  isAuthenticated: true,
                },
              });
            }
          } catch (_) {}

          chrome.runtime
            .sendMessage({
              action: 'authStateUpdated',
              authData: {
                isAuthenticated: true,
                user: globalAuthState.user,
                token: request.token,
              },
            })
            .catch(() => {});

          sendResponse({
            isAuthenticated: true,
            user: globalAuthState.user,
            token: request.token,
          });
        } catch (e) {
          sendResponse({ isAuthenticated: false });
        }
      })();
      return true;

    case 'getAuthConnectUrl':
      sendResponse({ url: `${API_CONFIG.platformUrl}/auth/extension-connect` });
      break;

    // Legacy backend path is intentionally isolated behind generic extension terminology.
    case 'voidr:getRecordingByCode':
    case 'voidr:getOnboardingByCode':
      (async () => {
        const code = (request.code || '').trim().toUpperCase();
        if (!code) {
          sendResponse({ context: null, error: 'No code provided' });
          return;
        }

        if (!globalAuthState.token) await checkAuthenticationStatus();
        if (!globalAuthState.token) {
          sendResponse({ context: null, error: 'Not authenticated' });
          return;
        }

        try {
          const res = await fetch(
            `${API_CONFIG.baseUrl}/onboarding/recording-sessions/code/${encodeURIComponent(code)}`,
            {
              headers: {
                Authorization: `Bearer ${globalAuthState.token}`,
                'Content-Type': 'application/json',
              },
            },
          );
          if (!res.ok) {
            sendResponse({
              context: null,
              error: res.status === 404 ? 'Código não encontrado' : `Error ${res.status}`,
            });
            return;
          }
          const json = await res.json();
          sendResponse({ context: json.data || null });
        } catch (e) {
          sendResponse({ context: null, error: e?.message || 'Network error' });
        }
      })();
      return true;

    case 'voidr:autoConnectOnboarding': {
      const autoCode = (request.code || '').trim().toUpperCase();
      if (!autoCode || !globalAuthState?.token) break;

      fetch(
        `${API_CONFIG.baseUrl}/onboarding/recording-sessions/code/${encodeURIComponent(autoCode)}`,
        {
          headers: {
            Authorization: `Bearer ${globalAuthState.token}`,
            'Content-Type': 'application/json',
          },
        },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (json?.data) {
            chrome.storage.session.set({ pendingRecordingCodeContext: json.data });
            chrome.action.setBadgeText({ text: 'REC' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
            try {
              chrome.action.openPopup();
            } catch (_) {}
          }
        })
        .catch(() => {});
      break;
    }

    case 'authLogout':
      // Limpa estado global no logout
      globalAuthState = {
        isAuthenticated: false,
        user: null,
        token: null,
      };
      console.log('User logged out');
      sendResponse({ success: true });
      break;

    case 'voidr:validateLoopRecordingToken':
      (async () => {
        const lifecycleGeneration = createLifecycleGeneration();
        const startupCapability = request.token;
        // The startup capability is transport-only. Never retain it in request
        // state or generation-scoped session storage.
        request.token = null;
        try {
          const tabId = sender?.tab?.id;
          if (!Number.isInteger(tabId)) {
            throw new Error('Loop Test recording authorization requires a content tab');
          }
          const response = await fetch(
            `${API_CONFIG.baseUrl}/loop-test/scenarios/recording-token/validate`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                scenarioId: request.scenarioId,
                token: startupCapability,
                ...(request.cycleId ? { cycleId: request.cycleId } : {}),
                lifecycleGeneration,
              }),
            },
          );
          if (!response.ok) {
            const errorPayload = await response.json().catch(() => null);
            const serverMessage =
              errorPayload?.message ||
              errorPayload?.error?.message ||
              errorPayload?.data?.message;
            throw new Error(
              response.status === 402
                ? 'Saldo de créditos insuficiente para iniciar este ciclo. Adicione créditos na Voidr e tente novamente; nenhuma gravação foi iniciada.'
                : serverMessage ||
                    `Loop Test recording authorization failed (HTTP ${response.status})`,
            );
          }
          const json = await response.json();
          const tabStillExists = await chrome.tabs
            .get(tabId)
            .then(() => true)
            .catch(() => false);
          if (!tabStillExists) {
            throw new Error('Loop Test recording tab closed during authorization');
          }
          const validation = json?.data || json;
          const attachCapability = validation?.attachToken;
          if (typeof attachCapability !== 'string' || !attachCapability) {
            throw new Error('Loop Test session attach authorization was not issued');
          }
          const staged = await loopCapabilitySecrets.stage(
            lifecycleGeneration,
            tabId,
            request.scenarioId,
            attachCapability,
          );
          if (!staged) throw new Error('Loop Test recording authorization could not be retained');
          const cycle = validation?.verification;
          const cycleCapability = validation?.verificationCapability;
          if (
            !cycle?.verificationId ||
            !cycle?.generation ||
            !cycleCapability?.token ||
            !cycleCapability?.expiresAt
          ) {
            throw new Error('Loop cycle recording authorization was not issued');
          }
          await persistVerificationCapability({
            verificationId: cycle.verificationId,
            generation: cycle.generation,
            bindingId: cycle.bindingId,
            token: cycleCapability.token,
            expiresAt: cycleCapability.expiresAt,
            lifecycleVersion: cycle.lifecycleVersion,
            createdAt: Date.now(),
            pending: [],
          });
          const {
            attachToken: _attachToken,
            verificationCapability: _verificationCapability,
            ...safeValidation
          } = validation;
          sendResponse({
            success: true,
            data: { ...safeValidation, lifecycleGeneration },
          });
        } catch (error) {
          sendResponse({ success: false, error: error?.message || String(error) });
        }
      })();
      return true;

    case 'apiRequest':
      // Faz requisições autenticadas para a API
      (async () => {
        if (LOCAL_VERIFICATION_ADAPTER && request.endpoint === '/customer-configs') {
          sendResponse({
            success: true,
            data: {
              success: true,
              data: { apiKey: LOCAL_VERIFICATION_COLLECTOR_KEY },
            },
          });
          return;
        }
        const isLocalVerificationRequest =
          LOCAL_VERIFICATION_ADAPTER &&
          (request.endpoint === '/verifications' ||
            request.endpoint?.startsWith('/verifications/'));
        if (
          !isLocalVerificationRequest &&
          (!globalAuthState.isAuthenticated || !globalAuthState.token)
        ) {
          await checkAuthenticationStatus();
        }

        if (
          !isLocalVerificationRequest &&
          (!globalAuthState.isAuthenticated || !globalAuthState.token)
        ) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }

        try {
          const response = await makeAuthenticatedRequest(
            request.endpoint,
            request.method || 'GET',
            request.data,
          );
          sendResponse({ success: true, data: response });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'captureScreenshot':
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
        sendResponse({ screenshot: dataUrl });
      });
      return true;

    case 'voidr:validateSession':
      (async () => {
        if (!globalAuthState.token) await checkAuthenticationStatus();
        if (!globalAuthState.token || !request.sessionId) {
          sendResponse({ found: false });
          return;
        }
        try {
          const res = await fetch(
            `${API_CONFIG.baseUrl}/collectors/sessions/${encodeURIComponent(request.sessionId)}`,
            { headers: { Authorization: `Bearer ${globalAuthState.token}` } },
          );
          // O endpoint responde 200 mesmo para sessão inexistente (data: null),
          // então res.ok não basta — a sessão só persistiu se houver `data`.
          let found = false;
          let indexed = false;
          if (res.ok) {
            const json = await res.json().catch(() => null);
            found = !!(json && json.data);
            indexed = !!(json && json.indexStatus && json.indexStatus.indexed);
          }
          sendResponse({ found, indexed });
        } catch (_) {
          sendResponse({ found: false });
        }
      })();
      return true;

    case 'voidr:trackRecordingNote':
      (async () => {
        const recording = await hydrateActiveRecording();
        const tabId = sender?.tab?.id ?? null;
        const generation = String(request.lifecycleGeneration || '');
        if (
          !recording ||
          !Number.isInteger(tabId) ||
          !recording.trackedTabIds?.includes(tabId) ||
          generation !== recording.lifecycleGeneration
        ) {
          sendResponse({
            success: false,
            error: 'A nota pertence a uma gravação que não está mais ativa.',
          });
          return;
        }
        const raw = request.input || {};
        const note = String(raw.note || '')
          .trim()
          .slice(0, 1000);
        if (!note) {
          sendResponse({ success: false, error: 'Escreva uma nota antes de salvar.' });
          return;
        }
        const allowedKinds = new Set(['element', 'region', 'screen']);
        const numberOrNull = (value) =>
          Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
        const rect = raw.rect
          ? {
              x: numberOrNull(raw.rect.x),
              y: numberOrNull(raw.rect.y),
              width: numberOrNull(raw.rect.width),
              height: numberOrNull(raw.rect.height),
            }
          : null;
        const payload = {
          version: 'SESSION-NOTE/1',
          kind: allowedKinds.has(raw.kind) ? raw.kind : 'screen',
          note,
          pageUrl: String(raw.pageUrl || '').slice(0, 2048),
          timestampMs: numberOrNull(raw.timestampMs) || 0,
          selector: raw.selector ? String(raw.selector).slice(0, 500) : null,
          rect,
          viewport: raw.viewport
            ? {
                width: numberOrNull(raw.viewport.width),
                height: numberOrNull(raw.viewport.height),
              }
            : null,
        };
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (sessionNote) => {
              if (!window.VoidrCollector || typeof window.VoidrCollector.track !== 'function') {
                throw new Error('Voidr Collector is unavailable');
              }
              window.VoidrCollector.track('voidr.note', sessionNote);
            },
            args: [payload],
          });
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || 'Não foi possível salvar a nota na sessão.',
          });
        }
      })();
      return true;

    case 'voidr:trackRecordingVoice':
      (async () => {
        const recording = await hydrateActiveRecording();
        const tabId = sender?.tab?.id ?? null;
        const generation = String(request.lifecycleGeneration || '');
        if (
          !recording ||
          !Number.isInteger(tabId) ||
          !recording.trackedTabIds?.includes(tabId) ||
          generation !== recording.lifecycleGeneration
        ) {
          sendResponse({
            success: false,
            error: 'A nota de voz pertence a uma gravação que não está mais ativa.',
          });
          return;
        }
        const raw = request.input || {};
        const transcript = String(raw.transcript || '')
          .trim()
          .slice(0, 2000);
        if (!transcript) {
          sendResponse({ success: false, error: 'O transcript da nota de voz está vazio.' });
          return;
        }
        const payload = {
          version: 'SESSION-VOICE-NOTE/1',
          transcript,
          note: transcript,
          state: 'saved',
          segmentId: String(raw.segmentId || '').slice(0, 160) || null,
          language: String(raw.language || '').slice(0, 32) || null,
          pageUrl: String(raw.pageUrl || '').slice(0, 2048),
          durationMs: Number.isFinite(Number(raw.durationMs))
            ? Math.max(0, Number(raw.durationMs))
            : null,
          timestampMs: Number.isFinite(Number(raw.timestampMs))
            ? Math.max(0, Number(raw.timestampMs))
            : 0,
        };
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (voiceNote) => {
              if (!window.VoidrCollector || typeof window.VoidrCollector.track !== 'function') {
                throw new Error('Voidr Collector is unavailable');
              }
              window.VoidrCollector.track('voidr.voice', voiceNote);
            },
            args: [payload],
          });
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || 'Não foi possível vincular o transcript à sessão.',
          });
        }
      })();
      return true;

    case 'voidr:getLiveRecordingContext':
      (async () => {
        const recording = await hydrateActiveRecording();
        const tabId = sender?.tab?.id ?? null;
        const generation = String(request.lifecycleGeneration || '');
        if (
          !recording ||
          !Number.isInteger(tabId) ||
          !recording.trackedTabIds?.includes(tabId) ||
          generation !== recording.lifecycleGeneration
        ) {
          sendResponse({
            success: false,
            stale: generation !== recording?.lifecycleGeneration,
            error: 'O contexto live pertence a uma gravação que não está mais ativa.',
          });
          return;
        }
        const allowedCategories = new Set([
          'pages',
          'clicks',
          'requests',
          'errors',
          'notes',
          'voiceNotes',
        ]);
        const category = allowedCategories.has(request.category) ? request.category : null;
        const limit = Math.min(50, Math.max(1, Math.floor(Number(request.limit) || 20)));
        try {
          const result = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (options) => {
              if (
                !window.VoidrCollector ||
                typeof window.VoidrCollector.getLiveContext !== 'function'
              ) {
                return null;
              }
              return window.VoidrCollector.getLiveContext(options);
            },
            args: [{ category, limit }],
          });
          const context = result?.[0]?.result || null;
          sendResponse({
            success: true,
            degraded: !context,
            context,
          });
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || 'Não foi possível ler o contexto da gravação.',
          });
        }
      })();
      return true;

    case 'voidr:pauseSession':
    case 'voidr:resumeSession': {
      const method = request.action === 'voidr:pauseSession' ? 'pause' : 'resume';
      const tabId = sender?.tab?.id;
      if (!tabId) {
        sendResponse({ success: false, error: 'No tab' });
        return true;
      }
      chrome.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (m) => {
            try {
              if (window.VoidrCollector && typeof window.VoidrCollector[m] === 'function') {
                window.VoidrCollector[m]();
              }
            } catch (_) {}
          },
          args: [method],
        })
        .then(() => sendResponse({ success: true }))
        .catch((e) => sendResponse({ success: false, error: e?.message }));
      return true;
    }

    case 'voidr:discardSession':
      (async () => {
        const recording = await hydrateActiveRecording();
        const tabId = sender?.tab?.id ?? null;
        const authorization = VoidrRecordingLifecycle.authorizeDiscardRequest(
          recording,
          request.lifecycleGeneration,
          tabId,
        );
        if (!authorization.authorized) {
          sendResponse({
            success: false,
            stale: authorization.reason === 'stale-generation',
            busy: authorization.reason === 'stop-in-progress',
            error:
              authorization.reason === 'stop-in-progress'
                ? 'Discard is unavailable while recording finalization is in progress. Wait for Stop to finish, then try again.'
                : authorization.reason === 'untracked-tab'
                  ? 'Discard rejected: sender tab is not tracked by this recording'
                  : 'Discard rejected: recording generation is stale',
          });
          return;
        }

        const cleared = await clearActiveRecordingForGeneration(
          request.lifecycleGeneration,
          ['starting', 'recording'],
          async (current) => {
            for (const trackedTabId of current.trackedTabIds || []) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: trackedTabId },
                  world: 'MAIN',
                  func: () => {
                    try {
                      window.VoidrCollector?.endSession?.();
                    } catch (_) {}
                    for (const key of [
                      'voidr_jwt',
                      'voidr_session_id',
                      'voidr_user_id',
                      'voidr_last_activity',
                    ]) {
                      try {
                        sessionStorage.removeItem(key);
                      } catch (_) {}
                    }
                  },
                });
              } catch (_) {}
              await disableCspBypassForTab(trackedTabId);
            }
          },
        );
        sendResponse({
          success: cleared,
          stale: !cleared,
          error: cleared ? null : 'Discard rejected: recording generation changed',
        });
      })();
      return true;
    case 'openFloatingPopup':
      // Persiste URL atual para manter contexto na janela flutuante
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
        const t = tabs && tabs[0] ? tabs[0] : null;
        const url = t && t.url && /^https?:/i.test(t.url) ? t.url : '';
        if (t && t.id && /^https?:/i.test(t.url || '')) {
          lastActiveContentTabId = t.id;
        }
        try {
          await chrome.storage.local.set({ lastActiveContentUrl: url });
        } catch (_) {}

        // Tenta focar uma janela existente (memória, storage, varredura)
        const existingId = await focusExistingAssistantWindow();
        if (existingId) {
          sendResponse({ success: true, refocused: true, windowId: existingId });
          return;
        }

        // Se não existir, cria nova
        const createdId = await openAssistantWindowAt();
        sendResponse({ success: true, created: true, windowId: createdId });
      });
      return true;

    case 'forwardToLastContent':
      (async () => {
        const payload = request.payload || {};
        let targetTabId = lastActiveContentTabId;
        if (!targetTabId) {
          try {
            const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
            let chosen = null;
            const focused = wins.find((w) => w.focused);
            const candidates = focused ? [focused, ...wins.filter((w) => w !== focused)] : wins;
            for (const w of candidates) {
              const activeTab = (w.tabs || []).find(
                (t) => t.active && t.url && /^https?:/i.test(t.url),
              );
              if (activeTab) {
                chosen = activeTab;
                break;
              }
            }
            if (!chosen) {
              for (const w of wins) {
                const httpTab = (w.tabs || []).find((t) => t.url && /^https?:/i.test(t.url));
                if (httpTab) {
                  chosen = httpTab;
                  break;
                }
              }
            }
            if (chosen && chosen.id) {
              targetTabId = chosen.id;
              lastActiveContentTabId = chosen.id;
            }
          } catch (e) {}
        }
        if (!targetTabId) {
          sendResponse({
            success: false,
            error: `Nenhuma aba alvo encontrada [targetHost=${targetHost} origens=${JSON.stringify(((await chrome.permissions.getAll().catch(() => ({}))).origins) || [])}]`,
          });
          return;
        }
        try {
          await chrome.tabs.sendMessage(targetTabId, payload);
          sendResponse({ success: true, forwarded: true, tabId: targetTabId });
        } catch (e) {
          // Fallback: inject content script and retry once
          try {
            await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              files: ['content/content.js'],
            });
            await ensureContentCss(targetTabId);
            await new Promise((r) => setTimeout(r, 100));
            await chrome.tabs.sendMessage(targetTabId, payload);
            sendResponse({ success: true, forwarded: true, injected: true, tabId: targetTabId });
          } catch (e2) {
            sendResponse({
              success: false,
              error: `${e2?.message || 'Failed to send message'} [${await contextoDeAcesso(targetTabId)}]`,
            });
          }
        }
      })();
      return true;

    case 'voidr:forwardToTargetTab':
      (async () => {
        const { targetHost, payload } = request;
        try {
          let targetTabId = null;

          if (targetHost) {
            const tabs = await chrome.tabs.query({ url: targetHost });
            const filtered = tabs.filter((t) => !t.url.startsWith(API_CONFIG.platformUrl));
            if (filtered.length > 0) {
              targetTabId = filtered[0].id;
            } else {
              const alt = targetHost.startsWith('http://')
                ? targetHost.replace('http://', 'https://')
                : targetHost.replace('https://', 'http://');
              const altTabs = await chrome.tabs.query({ url: alt });
              const altFiltered = altTabs.filter((t) => !t.url.startsWith(API_CONFIG.platformUrl));
              if (altFiltered.length > 0) targetTabId = altFiltered[0].id;
            }
          }

          if (!targetTabId) {
            const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (
              active?.url &&
              /^https?:/i.test(active.url) &&
              !active.url.startsWith(API_CONFIG.platformUrl)
            ) {
              targetTabId = active.id;
            }
          }

          // The floating assistant window breaks the active-tab fallback above
          // (the "current window" is the popup itself), which silently opened a
          // fresh targetUrl tab instead of recording the page the user was on.
          // lastActiveContentTabId is stamped when the popup opens, so it points
          // at exactly that page.
          if (!targetTabId && Number.isInteger(lastActiveContentTabId)) {
            const last = await chrome.tabs.get(lastActiveContentTabId).catch(() => null);
            if (
              last?.url &&
              /^https?:/i.test(last.url) &&
              !last.url.startsWith(API_CONFIG.platformUrl)
            ) {
              targetTabId = last.id;
            }
          }

          if (!targetTabId && request.targetUrl) {
            const newTab = await chrome.tabs.create({ url: request.targetUrl, active: true });
            targetTabId = newTab.id;
            await new Promise((r) => setTimeout(r, 2000));
          }

          if (!targetTabId) {
            sendResponse({
              success: false,
              error: 'Aba do site-alvo não encontrada. Abra o site e tente novamente.',
            });
            return;
          }

          try {
            await chrome.tabs.sendMessage(targetTabId, payload);
          } catch (_) {
            await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              files: ['content/content.js'],
            });
            await ensureContentCss(targetTabId);
            await new Promise((r) => setTimeout(r, 100));
            await chrome.tabs.sendMessage(targetTabId, payload);
          }
          sendResponse({ success: true, tabId: targetTabId });
        } catch (e) {
          sendResponse({
            success: false,
            error: `${e?.message || 'Failed to forward to target tab'} [${await contextoDeAcesso(targetTabId)}]`,
          });
        }
      })();
      return true;

    case 'voidr:retryLoopAttach':
      (async () => {
        try {
          if (!request?.sessionId || !request?.scenarioId || !request?.lifecycleGeneration) {
            throw new Error('Missing sealed session attachment coordinates');
          }
          await attachLoopTestSession(
            request.sessionId,
            { scenarioId: request.scenarioId },
            request.lifecycleGeneration,
          );
          sendResponse({ success: true, attached: true });
        } catch (error) {
          sendResponse({
            success: false,
            attached: false,
            error: error?.message || String(error),
          });
        }
      })();
      return true;

    case 'voidr:sessionStopped':
      // On stop, try to retrieve the current sessionId from the page and broadcast all accumulated sessions
      (async () => {
        let priorRecording = null;
        let stopToken = null;
        let recordingCleared = false;
        let resolveStopRequest = sendResponse;
        try {
          priorRecording = await hydrateActiveRecording();
          if (!priorRecording) {
            sendResponse({ success: false, error: 'No active recording to finalize' });
            return;
          }
          const authorizationSenderTabId = isTrustedAssistantSender(sender)
            ? null
            : (sender?.tab?.id ?? null);
          let stopAuthorization = VoidrRecordingLifecycle.authorizeStopRequest(
            priorRecording,
            request.lifecycleGeneration,
            authorizationSenderTabId,
          );
          if (
            !stopAuthorization.authorized &&
            stopAuthorization.reason === 'untracked-tab' &&
            Number.isInteger(sender?.tab?.id)
          ) {
            const senderSessionId = await readCollectorSessionId(sender.tab.id);
            if (
              VoidrRecordingLifecycle.canRecoverStopSender(
                priorRecording,
                sender.tab.id,
                senderSessionId,
              )
            ) {
              const recovered = await attachTrackedRecordingTab(sender.tab.id, {
                makeCurrent: true,
                expectedToken: VoidrRecordingLifecycle.lifecycleToken(priorRecording),
              });
              if (recovered) {
                priorRecording = recovered;
                stopAuthorization = VoidrRecordingLifecycle.authorizeStopRequest(
                  priorRecording,
                  request.lifecycleGeneration,
                  sender.tab.id,
                );
              }
            }
          }
          if (
            !stopAuthorization.authorized &&
            stopAuthorization.reason === 'untracked-tab' &&
            Number.isInteger(sender?.tab?.id) &&
            (await stopCapabilitySecrets.verify(
              priorRecording.lifecycleGeneration,
              sender.tab.id,
              priorRecording.canonicalSessionId,
              request.stopCapability,
            ))
          ) {
            stopAuthorization = { authorized: true, reason: null };
          }
          if (!stopAuthorization.authorized) {
            sendResponse({
              success: false,
              finalized: false,
              stale: stopAuthorization.reason === 'stale-generation',
              error:
                stopAuthorization.reason === 'untracked-tab'
                  ? 'Stop rejected: sender tab is not tracked by this recording'
                  : 'Stop rejected: recording generation is stale',
            });
            return;
          }
          const stopRequest = stopRequestLatch.begin(priorRecording.lifecycleGeneration);
          stopRequest.promise.then(sendResponse);
          if (!stopRequest.isOwner) return;
          resolveStopRequest = stopRequest.resolve;

          const stoppingRecording = await updateActiveRecordingForGeneration(
            priorRecording.lifecycleGeneration,
            (recording) => ({ ...recording, lifecycle: 'stopping' }),
            ['starting', 'recording'],
          );
          if (!stoppingRecording) {
            resolveStopRequest({
              success: false,
              error: 'Recording lifecycle changed before stop could begin',
            });
            return;
          }
          stopToken = VoidrRecordingLifecycle.lifecycleToken(stoppingRecording);
          const priorSessionIds = priorRecording?.sessionIds || [];

          const senderTabId = sender?.tab?.id ?? null;
          let targetTabId = isTrackedRecordingTab(priorRecording, senderTabId)
            ? senderTabId
            : priorRecording?.currentTabId || priorRecording?.tabId;
          const sessionId =
            priorRecording?.canonicalSessionId ||
            (Number.isInteger(targetTabId) ? await readCollectorSessionId(targetTabId) : null) ||
            null;
          const activeRunId = request.onboardingRunId || null;
          // Evidence coordinates travel back with the captured session so the
          // platform can auto-attach it to the manual run without re-deriving.
          const evidenceMeta = priorRecording?.evidence || null;
          // Loop-test coordinates too — but never the recording token, which
          // must not leak into broadcast listeners.
          const loopTestMeta = priorRecording?.loopTest
            ? {
                scenarioId: priorRecording.loopTest.scenarioId,
                attemptIndex: priorRecording.loopTest.attemptIndex,
              }
            : null;

          // Merge current sessionId with all previously accumulated ones
          const allSessionIds = [...new Set([...priorSessionIds, sessionId].filter(Boolean))];
          if (allSessionIds.length === 0) {
            await updateActiveRecordingForGeneration(
              stopToken.generation,
              { ...priorRecording, lifecycle: 'recording' },
              ['stopping'],
            );
            resolveStopRequest({ success: false, error: 'No sessionId available to finalize' });
            return;
          }

          const trackedTabIds = [
            ...new Set(
              [
                ...(priorRecording?.trackedTabIds || []),
                ...(priorRecording?.unacknowledgedRemovals || []).map((removal) => removal.tabId),
                Number.isInteger(targetTabId) ? targetTabId : null,
              ].filter(Number.isInteger),
            ),
          ];
          if (trackedTabIds.length === 0) {
            await updateActiveRecordingForGeneration(
              stopToken.generation,
              { ...priorRecording, lifecycle: 'recording' },
              ['stopping'],
            );
            resolveStopRequest({
              success: false,
              sessionId,
              sessionIds: allSessionIds,
              finalized: false,
              error: 'No tracked recording tabs are available to quiesce',
            });
            return;
          }

          // Quiesce every tab, then group by the sessionId each collector
          // actually stopped. Tabs may have rotated independently.
          const removalByTabId = new Map(
            (priorRecording?.unacknowledgedRemovals || []).map((removal) => [
              removal.tabId,
              removal,
            ]),
          );
          const quiescence = await VoidrSessionStopHelpers.finalizeTrackedTabs({
            tabIds: trackedTabIds,
            stopTab: async (tabId) => {
              const tombstone = removalByTabId.get(tabId);
              if (tombstone) {
                return {
                  sessionId: tombstone.sessionId || sessionId,
                  ok: false,
                  flushed: false,
                  removed: true,
                  unacknowledged: true,
                  error: 'Tracked tab closed before collector flush acknowledgement',
                };
              }
              try {
                return await quiesceCollectorInTab(tabId);
              } catch (error) {
                const tabStillExists = await chrome.tabs
                  .get(tabId)
                  .then(() => true)
                  .catch(() => false);
                if (!tabStillExists) {
                  return {
                    sessionId,
                    ok: false,
                    flushed: false,
                    removed: true,
                    error: 'Tracked tab closed before collector flush acknowledgement',
                  };
                }
                throw error;
              }
            },
            sealSession: async ({
              sessionId: stoppedSessionId,
              finalizedThrough,
              compatibilityResults,
            }) => {
              const compatibilityReason =
                compatibilityResults.length > 0
                  ? 'One or more tabs used the legacy collector compatibility path'
                  : null;
              return finalizeSessionDirect(stoppedSessionId, priorRecording?.initOptions, {
                reason: compatibilityReason,
                finalizedThrough,
              });
            },
          });
          const finalizations = quiescence.finalizations || {};
          const finalizedSessionIds = [...new Set(quiescence.successfulSessionIds || [])];
          const primarySessionId =
            (finalizedSessionIds.includes(sessionId) && sessionId) ||
            finalizedSessionIds[finalizedSessionIds.length - 1] ||
            sessionId;
          let attachmentError = null;
          const retryPlan = VoidrRecordingLifecycle.reconcileRemovedTabsForRetry(
            priorRecording,
            quiescence.results,
          );

          if (finalizedSessionIds.length > 0 && priorRecording?.initOptions?.loopTest) {
            try {
              await attachLoopTestSession(
                primarySessionId,
                priorRecording.initOptions.loopTest,
                stopToken.generation,
              );
            } catch (error) {
              attachmentError = error?.message || String(error);
            }
          }
          const stopOutcome = VoidrSessionStopHelpers.classifyStopOutcome({
            quiescencePartialFailure: quiescence.partialFailure,
            finalizedSessionIds,
            attachmentError,
          });

          // Recording lifecycle is governed exclusively by the authoritative
          // collector seal. An attach failure happens after the seal and must
          // never reactivate the recorder or append chunks to a sealed session.
          if (!stopOutcome.sealFailed) {
            recordingCleared = await clearActiveRecordingForGeneration(
              stopToken.generation,
              ['stopping'],
              async () => {
                for (const t of trackedTabIds) {
                  await disableCspBypassForTab(t);
                }
              },
              { preserveLoopCapability: stopOutcome.attachmentPending },
            );
          } else if (retryPlan.policy === 'retry' && retryPlan.recording) {
            // Only a failed seal is retryable. Restore a coherent recording state so
            // the existing retry controls can deliberately start another stop.
            // Tabs confirmed removed are excluded so retries cannot loop on
            // dead tab ids. Their missing flush remains a failure in this run.
            await updateActiveRecordingForGeneration(
              stopToken.generation,
              { ...retryPlan.recording, lifecycle: 'recording' },
              ['stopping'],
            );
          } else {
            // No collector tab remains. There is nothing a retry can quiesce,
            // so terminate this generation without claiming the missing ACK.
            recordingCleared = await clearActiveRecordingForGeneration(
              stopToken.generation,
              ['stopping'],
              async () => {
                for (const t of trackedTabIds) await disableCspBypassForTab(t);
              },
            );
          }

          // Cookie upload is best-effort, but it must happen after the final
          // recording chunk/seal and before consumers hear sessionCaptured.
          if (
            priorRecording?.initOptions?.captureEnvironmentBundle &&
            finalizedSessionIds.includes(primarySessionId)
          ) {
            try {
              const tab = Number.isInteger(targetTabId)
                ? await chrome.tabs.get(targetTabId).catch(() => null)
                : null;
              await withTimeout(
                captureAndUploadCookies(primarySessionId, tab?.url),
                COOKIE_UPLOAD_TIMEOUT_MS,
                `Cookie upload timed out after ${COOKIE_UPLOAD_TIMEOUT_MS}ms`,
              );
            } catch (_) {}
          }

          // Onboarding-code captures can belong to another org. Link only
          // durably finalized sessions through the code-scoped endpoint.
          const onboardingLink = await linkOnboardingSessions(priorRecording, finalizedSessionIds);

          // Persist a marker so the popup can show a success screen when reopened
          // and trust the code-scoped confirmation for cross-org captures.
          try {
            const latestSid = primarySessionId || null;
            const isLoopCycleCapture = Boolean(
              priorRecording?.loopTest || priorRecording?.initOptions?.meta?.verification,
            );
            if (
              latestSid &&
              !isLoopCycleCapture &&
              (!activeRunId || onboardingLink.code) &&
              !stopOutcome.sealFailed
            ) {
              await chrome.storage.session.set({
                voidrLastCapture: {
                  sessionId: latestSid,
                  capturedAt: Date.now(),
                  confirmed: onboardingLink.confirmed,
                  code: onboardingLink.code || undefined,
                },
              });
              // Reopen the assistant popup so the success screen shows automatically.
              try {
                const existing = await focusExistingAssistantWindow();
                if (!existing) await openAssistantWindowAt();
              } catch (_) {}
            }
          } catch (_) {}

          // Broadcast only sessions whose own authoritative seal succeeded.
          // The array preserves the existing accumulated-session attachment
          // contract without claiming failed siblings as captured.
          for (const sid of finalizedSessionIds) {
            // Loop consumers must not observe a session before its scenario
            // binding exists. The content controller performs one safe,
            // idempotent attach retry before it broadcasts.
            if (loopTestMeta && stopOutcome.attachmentPending) continue;
            const capturedPayload = {
              action: 'voidr:sessionCaptured',
              sessionId: sid,
              onboardingRunId: activeRunId,
              evidence: evidenceMeta || undefined,
              loopTest: loopTestMeta || undefined,
              finalization: finalizations[sid],
              lifecycleGeneration: stopToken.generation,
            };
            try {
              chrome.runtime.sendMessage(capturedPayload).catch(() => {});
            } catch (_) {}

            try {
              const allTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
              for (const t of allTabs) {
                chrome.tabs.sendMessage(t.id, capturedPayload).catch(() => {});
              }
            } catch (_) {}

            try {
              const platformTabs = await chrome.tabs.query({ url: `${API_CONFIG.platformUrl}/*` });
              for (const pt of platformTabs) {
                chrome.scripting
                  .executeScript({
                    target: { tabId: pt.id },
                    world: 'MAIN',
                    func: (payload) => {
                      try {
                        const bc = new BroadcastChannel('voidr-onboarding');
                        bc.postMessage(payload);
                        bc.close();
                      } catch (_) {}
                    },
                    args: [
                      {
                        type: 'voidr:sessionCaptured',
                        sessionId: sid,
                        onboardingRunId: activeRunId,
                        evidence: evidenceMeta || undefined,
                        loopTest: loopTestMeta || undefined,
                        finalization: finalizations[sid],
                        lifecycleGeneration: stopToken.generation,
                      },
                    ],
                  })
                  .catch(() => {});
              }
            } catch (_) {}
          }

          const verificationCoordinates = safeVerificationCoordinates(priorRecording);
          const stopResponse = {
            success: stopOutcome.success,
            sessionId: primarySessionId,
            sessionIds: finalizedSessionIds,
            loopTest: priorRecording?.loopTest
              ? {
                  scenarioId: priorRecording.loopTest.scenarioId,
                  cycleId: priorRecording.loopTest.cycleId,
                  cycleNumber: priorRecording.loopTest.cycleNumber,
                }
              : null,
            lifecycleGeneration: stopToken.generation,
            verification: verificationCoordinates,
            finalized: stopOutcome.finalized,
            partial: stopOutcome.partial,
            attachmentPending: stopOutcome.attachmentPending,
            attachmentError,
            retryable: stopOutcome.sealFailed && retryPlan.policy === 'retry',
            terminal: stopOutcome.sealFailed && retryPlan.policy === 'terminal',
            degraded:
              stopOutcome.sealFailed ||
              stopOutcome.attachmentPending ||
              Object.values(finalizations).some((result) => result?.degraded === true),
            finalizations,
            error: stopOutcome.sealFailed
              ? [
                  ...quiescence.failures.map((failure) => `tab ${failure.tabId}: ${failure.error}`),
                  ...quiescence.finalizationFailures.map(
                    (failure) =>
                      `${failure.sessionId ? `session ${failure.sessionId}` : `tab ${failure.tabId}`}: ${failure.error}`,
                  ),
                ].join('; ') || 'No session seal was confirmed'
              : null,
            warning: stopOutcome.attachmentPending
              ? `Session sealed, but Loop attachment is pending: ${attachmentError}`
              : null,
            tabResults: quiescence.results,
          };
          // Queue the Verification seal before acknowledging Stop. The popup or
          // in-page controller may disappear as soon as the user clicks Finish;
          // the MV3 alarm is the durable owner that keeps the Cursor/MCP handoff
          // moving even with no UI connected.
          if (stopOutcome.finalized && verificationCoordinates) {
            try {
              const found = await readVerificationCapability(
                verificationCoordinates.verificationId,
                verificationCoordinates.generation,
              );
              if (!found) throw new Error('Verification capability is expired or revoked');
              await stageVerificationSeal(found.record, verificationCoordinates, stopResponse);
              await scheduleVerificationSealRetry(found.record);
            } catch (error) {
              await persistLoopFinalization(verificationCoordinates, {
                state: 'failed',
                sessionId: primarySessionId,
                error: error?.message || String(error),
              }).catch(() => undefined);
              stopResponse.verificationError = error?.message || String(error);
            }
          }
          await chrome.storage.session.set({
            voidrLastStopResult: { ...stopResponse, stoppedAt: Date.now() },
          });
          resolveStopRequest(stopResponse);
        } catch (e) {
          if (priorRecording && stopToken && !recordingCleared) {
            await updateActiveRecordingForGeneration(
              stopToken.generation,
              { ...priorRecording, lifecycle: 'recording' },
              ['stopping'],
            ).catch(() => {});
          }
          resolveStopRequest({
            success: false,
            error: e?.message || 'Failed to retrieve sessionId on stop',
          });
        }
      })();
      return true;
    case 'voidr:openLoop': {
      const scenarioId = encodeURIComponent(String(request.scenarioId || ''));
      if (!scenarioId) {
        sendResponse({ success: false, error: 'Loop coordinates are missing' });
        break;
      }
      chrome.tabs
        .create({ url: `${API_CONFIG.platformUrl}/loops/${scenarioId}`, active: true })
        .then(() => sendResponse({ success: true }))
        .catch((error) =>
          sendResponse({ success: false, error: error?.message || 'Could not open Loop' }),
        );
      return true;
    }
    case 'voidr:openLoopCycle': {
      const scenarioId = encodeURIComponent(String(request.scenarioId || ''));
      const cycleId = encodeURIComponent(String(request.cycleId || ''));
      if (!scenarioId || !cycleId) {
        sendResponse({ success: false, error: 'Loop cycle coordinates are missing' });
        break;
      }
      chrome.tabs
        .create({
          url: `${API_CONFIG.platformUrl}/loops/${scenarioId}/cycles/${cycleId}`,
          active: true,
        })
        .then((tab) => sendResponse({ success: true, tabId: tab.id }))
        .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
      return true;
    }
    case 'voidr:openLoopHandoff': {
      try {
        const path = VoidrLoopBootstrap.buildLoopCodeHandoffPath({
          scenarioId: request.scenarioId,
          cycleId: request.cycleId,
          agent: request.agent,
        });
        chrome.tabs
          .create({ url: `${API_CONFIG.platformUrl}${path}`, active: true })
          .then((tab) => sendResponse({ success: true, tabId: tab.id }))
          .catch((error) =>
            sendResponse({ success: false, error: error?.message || String(error) }),
          );
      } catch (error) {
        sendResponse({ success: false, error: error?.message || String(error) });
      }
      return true;
    }

    case 'focusOrOpenPopup':
      (async () => {
        try {
          const popupUrl = chrome.runtime.getURL('popup/popup.html');
          const desired = request.position || {};

          // Try to focus existing popup window
          if (lastPopupWindowId) {
            try {
              await chrome.windows.update(lastPopupWindowId, { focused: true });
              console.log('[Voidr BG] Focused existing popup:', lastPopupWindowId);
              sendResponse({ success: true, refocused: true });
              return;
            } catch (_) {
              lastPopupWindowId = null;
            }
          }

          // Create new popup window
          const specs = { url: popupUrl, type: 'popup', width: 420, height: 550, focused: true };
          if (typeof desired.left === 'number') specs.left = Math.max(0, desired.left);
          if (typeof desired.top === 'number') specs.top = Math.max(0, desired.top);

          const win = await chrome.windows.create(specs);
          lastPopupWindowId = win?.id || null;
          console.log('[Voidr BG] Created popup window:', lastPopupWindowId);
          sendResponse({ success: true, created: true, windowId: win?.id });
        } catch (e) {
          console.error('[Voidr BG] focusOrOpenPopup failed:', e);
          sendResponse({ success: false, error: e?.message });
        }
      })();
      return true;

    default:
      console.log('Ação não reconhecida:', request.action);
  }
});

// Track last active content tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  try {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (
        tab &&
        tab.id &&
        tab.url &&
        /^https?:/i.test(tab.url) &&
        !tab.url.startsWith(API_CONFIG.platformUrl)
      ) {
        lastActiveContentTabId = tab.id;
      }
    });
  } catch (_) {}

  hydrateActiveRecording().then((recording) => {
    if (!recording || !isTrackedRecordingTab(recording, activeInfo.tabId)) return;
    attachTrackedRecordingTab(activeInfo.tabId, { makeCurrent: true });
  });
});

// Faz requisições autenticadas para a API
async function makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
  try {
    const isLocalVerificationRequest =
      LOCAL_VERIFICATION_ADAPTER &&
      (endpoint === '/verifications' || endpoint.startsWith('/verifications/'));
    console.log(
      '[API] →',
      method,
      endpoint,
      data ? (isLocalVerificationRequest ? '[sensitive body redacted]' : '[body]') : '',
    );
    const options = {
      method: method,
      headers: isLocalVerificationRequest
        ? {
            'Content-Type': 'application/json',
            'x-voidr-dev-key': LOCAL_VERIFICATION_KEY,
            'x-voidr-organization-id': LOCAL_VERIFICATION_ORGANIZATION,
          }
        : {
            Authorization: `Bearer ${globalAuthState.token}`,
            'Content-Type': 'application/json',
          },
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }

    const resolvedEndpoint = isLocalVerificationRequest ? `/verification-dev${endpoint}` : endpoint;
    const url = `${API_CONFIG.baseUrl}${resolvedEndpoint}`;
    const response = await fetch(url, options);

    if (!response.ok) {
      if (response.status === 401 && !isLocalVerificationRequest) {
        // Token expirado, limpa autenticação
        console.log('Token expired (401), clearing authentication...');
        globalAuthState = {
          isAuthenticated: false,
          user: null,
          token: null,
        };
        await chrome.storage.local.remove(['voidrAuth']);

        // Notifica sobre expiração sem causar loop
        chrome.runtime
          .sendMessage({
            action: 'authExpired',
          })
          .catch(() => {
            // Ignora erros se não há listeners
          });

        throw new Error('Authentication expired');
      }
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch (_) {}
      let errorPayload = null;
      try {
        errorPayload = bodyText ? JSON.parse(bodyText) : null;
      } catch (_) {}
      const serverMessage =
        errorPayload?.message || errorPayload?.error?.message || errorPayload?.data?.message;
      console.warn('[API] ←', method, endpoint, response.status, response.statusText);
      throw new Error(
        response.status === 402
          ? 'Saldo de créditos insuficiente para iniciar este ciclo. Adicione créditos na Voidr e tente novamente.'
          : serverMessage || `API request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = await response.json();
    console.log('[API] ←', method, endpoint, '200 OK');
    return json;
  } catch (error) {
    console.error('API request error:', error);
    throw error;
  }
}

// Verifica autenticação periodicamente (a cada 30 minutos)
setInterval(
  () => {
    checkAuthenticationStatus();
  },
  30 * 60 * 1000,
);

// Quando o usuário clica no ícone da extensão, abre a janela flutuante
chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
    const t = tabs && tabs[0] ? tabs[0] : null;
    const url = t && t.url && /^https?:/i.test(t.url) ? t.url : '';
    try {
      await chrome.storage.local.set({ lastActiveContentUrl: url });
    } catch (_) {}

    const existingId = await focusExistingAssistantWindow();
    if (existingId) return;
    await openAssistantWindowAt();
  });
});

// Listener para detectar quando a plataforma Voidr é acessada
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const recording = await hydrateActiveRecording();

  // Re-inject collector + recording UI when any tracked tab completes a navigation
  if (
    changeInfo.status === 'complete' &&
    recording &&
    VoidrRecordingLifecycle.shouldResumeOnNavigation(recording) &&
    isTrackedRecordingTab(recording, tabId) &&
    tab.url &&
    /^https?:/i.test(tab.url)
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (await resumeActiveRecordingInTab(tabId)) break;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith(API_CONFIG.platformUrl)) {
    console.log('Voidr platform detected, syncing authentication...');

    // Verifica se é a rota de conexão da extensão
    if (tab.url.includes('/auth/extension-connect')) {
      console.log('Extension connect route detected');

      // Aguarda um pouco mais para garantir que a autenticação foi processada
      setTimeout(async () => {
        await syncAuthWithPlatform(tabId);

        // Notifica todas as abas da extensão sobre a autenticação bem-sucedida
        // Sem receptor (popup fechado) a promise rejeita e suja o console do worker.
        chrome.runtime
          .sendMessage({
            action: 'authenticationCompleted',
            user: globalAuthState.user,
          })
          .catch(() => {});
      }, 3000);
    } else {
      // Sincronização normal para outras páginas
      setTimeout(async () => {
        await syncAuthWithPlatform(tabId);
      }, 2000);
    }
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.openerTabId)) return;
  if (!activeRecording && !chrome?.storage?.local) return;

  hydrateActiveRecording().then((recording) => {
    if (
      !recording ||
      recording.lifecycle === 'stopping' ||
      !isTrackedRecordingTab(recording, tab.openerTabId)
    )
      return;
    attachTrackedRecordingTab(tab.id, { makeCurrent: true });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Always remove the CSP bypass rule for a closed tab — idempotent.
  disableCspBypassForTab(tabId).catch(() => {});
  loopBootstrapStaging.discard(tabId).catch(() => {});
  loopCapabilitySecrets.discardTab(tabId).catch(() => {});
  stopCapabilitySecrets.discardTab(tabId).catch(() => {});

  hydrateActiveRecording().then(async (recording) => {
    if (!recording) return;
    const lifecycleToken = VoidrRecordingLifecycle.lifecycleToken(recording);
    const removal = VoidrRecordingLifecycle.planTrackedTabRemoval(recording, tabId);
    if (removal.action === 'ignore') return;
    await updateActiveRecordingIfCurrent(lifecycleToken, removal.recording);
  });
});

/**
 *
 * @returns Resync auth reading Auth0 token from platform
 */
async function resyncAuthFromPlatformTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: `${API_CONFIG.platformUrl}/*` });
    for (const tab of tabs) {
      try {
        await syncAuthWithPlatform(tab.id);
        if (globalAuthState.isAuthenticated && globalAuthState.token) return true;
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}
// Sincroniza autenticação com a plataforma
async function syncAuthWithPlatform(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (cacheKey) => {
        try {
          const auth0Cache = localStorage.getItem(cacheKey);
          if (auth0Cache) {
            const cacheData = JSON.parse(auth0Cache);
            return {
              token: cacheData.body?.access_token || null,
              expiresAt: cacheData.body?.expires_at || null,
              user: cacheData.body?.decodedToken?.user || null,
            };
          }
          return null;
        } catch (e) {
          console.error('Error accessing platform auth:', e);
          return null;
        }
      },
      args: [API_CONFIG.auth0.cacheKey],
    });

    if (result && result[0] && result[0].result && result[0].result.token) {
      const platformAuth = result[0].result;

      // Valida o token encontrado
      const isValid = await validateTokenInBackground(platformAuth.token);

      if (isValid) {
        // Atualiza estado global
        globalAuthState = {
          isAuthenticated: true,
          user: isValid.user,
          token: platformAuth.token,
        };

        // Armazena na extensão
        await chrome.storage.local.set({
          voidrAuth: {
            token: platformAuth.token,
            user: isValid.user,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            isAuthenticated: true,
          },
        });

        console.log('Authentication synced with platform for:', isValid.user?.email);

        // Notifica todas as abas e popups sobre a autenticação
        chrome.runtime
          .sendMessage({
            action: 'authStateUpdated',
            authData: {
              isAuthenticated: true,
              user: isValid.user,
              token: platformAuth.token,
            },
          })
          .catch(() => {});

        // Notify content scripts directly in all http(s) tabs
        try {
          const allTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
          for (const t of allTabs) {
            chrome.tabs
              .sendMessage(t.id, {
                action: 'authStateUpdated',
                authData: { isAuthenticated: true, user: isValid.user, token: platformAuth.token },
              })
              .catch(() => {});
          }
        } catch (_) {}
      }
    }
  } catch (error) {
    console.error('Error syncing auth with platform:', error);
  }
}

// Valida token no background (sem depender da página de auth)
async function validateTokenInBackground(token) {
  try {
    const response = await fetch(`${API_CONFIG.baseUrl}/auth/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const userData = await response.json();
      return { isValid: true, user: userData.data };
    }

    return false;
  } catch (error) {
    console.error('Background token validation error:', error);
    return false;
  }
}
