import { state } from './state.js';
import { safeStringify } from './utils/helpers.js';
import { TOKEN_REFRESH_MARGIN_MS, decodeJwtExp } from './utils/jwt.js';
import { targetChunkBytes } from './chunk-planner.js';

/**
 * Initialize the user ID from config or sessionStorage.
 */
export function initUser() {
  state.userId = state.config.user?.id || sessionStorage.getItem('voidr_user_id') || null;
}

/**
 * Initialize or restore the session ID.
 * Creates a new session if none exists or the previous one has expired.
 */
export function initSession() {
  const forcedSessionId =
    typeof state.config.forcedSessionId === 'string' && state.config.forcedSessionId.trim()
      ? state.config.forcedSessionId.trim()
      : null;
  state.sessionId = forcedSessionId || sessionStorage.getItem('voidr_session_id');
  const lastActivity = sessionStorage.getItem('voidr_last_activity');
  const sessionExpired = lastActivity
    ? Date.now() - parseInt(lastActivity) > state.config.sessionTimeout * 60 * 1000
    : true;

  if (forcedSessionId) {
    state.sessionId = forcedSessionId;
    sessionStorage.setItem('voidr_session_id', state.sessionId);
  } else if (!state.sessionId || sessionExpired) {
    state.sessionId = state.sessionStartedAt.toString();
    sessionStorage.setItem('voidr_session_id', state.sessionId);
  }

  sessionStorage.setItem('voidr_last_activity', Date.now());
}

/**
 * Authenticate the session with the collector server.
 * Tries to restore a cached JWT from sessionStorage first.
 * If no valid cached token, POSTs to /init to get a new one.
 * Returns true on success, false on failure.
 */
const isLifecycleCurrent = (lifecycleId) => state.lifecycleId === lifecycleId && !state.forceStop;

export async function authenticateSession(lifecycleId = state.lifecycleId) {
  const config = state.config;
  const sessionId = state.sessionId;
  const userId = state.userId;
  const storedJwt = sessionStorage.getItem('voidr_jwt');
  const storedSession = sessionStorage.getItem('voidr_session_id');

  if (storedJwt && storedSession && storedSession === sessionId) {
    // Only reuse the cached JWT while it's outside the refresh margin — a
    // restored tab shouldn't start on a token about to expire.
    const exp = decodeJwtExp(storedJwt);
    if (exp != null && exp * 1000 - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      if (!isLifecycleCurrent(lifecycleId)) return false;
      state.authToken = storedJwt;
      return true;
    }
  }

  sessionStorage.removeItem('voidr_jwt');

  const initPayload = {
    apiKey: config.apiKey,
    userId: userId || null,
    userTraits: config.user,
    meta: config.meta,
    system: Boolean(config.system),
    sessionId,
  };

  if (config.user && typeof config.user.name === 'string' && config.user.name.length > 0) {
    initPayload.userName = config.user.name;
  }
  if (config.applicationId) initPayload.applicationId = config.applicationId;
  if (config.environment) initPayload.environment = config.environment;

  // Initial page URL
  try {
    initPayload.initialUrl =
      typeof window !== 'undefined' && window.location ? window.location.href : null;
  } catch (_) {
    initPayload.initialUrl = null;
  }

  const response = await fetch(`${config.collectorUrl}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: safeStringify(initPayload),
  });

  if (!response.ok) {
    if (isLifecycleCurrent(lifecycleId)) {
      console.error('VoidrCollector: init failed with status', response.status);
    }
    return false;
  }

  const data = await response.json().catch(() => ({}));
  if (!isLifecycleCurrent(lifecycleId)) return false;
  const authToken = data.token || null;
  const authenticatedSessionId =
    typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : sessionId;
  // Server-driven recording config: authoritative over local options when
  // present, so ops can tune sampling / ignorelists / privacyLevel without a
  // client redeploy.
  if (data.recording && typeof data.recording === 'object') {
    state.config = { ...state.config, ...data.recording };
  }
  if (!authToken) {
    console.error('VoidrCollector: Failed to get authentication token');
    return false;
  }
  state.authToken = authToken;
  state.sessionId = authenticatedSessionId;
  state.chunkTargetBytes = targetChunkBytes(data.ingest?.maxChunkPayloadBytes);

  // Persist JWT and session ID for reuse on re-init (e.g. page reload)
  try {
    sessionStorage.setItem('voidr_jwt', state.authToken);
    sessionStorage.setItem('voidr_session_id', state.sessionId);
    if (userId) {
      sessionStorage.setItem('voidr_user_id', userId);
    }
  } catch (_) {}

  return true;
}
