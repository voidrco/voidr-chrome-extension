import { state } from './state.js';
import { safeStringify } from './utils/helpers.js';

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
export async function authenticateSession() {
  const storedJwt = sessionStorage.getItem('voidr_jwt');
  const storedSession = sessionStorage.getItem('voidr_session_id');

  if (storedJwt && storedSession && storedSession === state.sessionId) {
    state.authToken = storedJwt;
    return true;
  }

  sessionStorage.removeItem('voidr_jwt');

  const initPayload = {
    apiKey: state.config.apiKey,
    userId: state.userId || null,
    userTraits: state.config.user,
    meta: state.config.meta,
    system: Boolean(state.config.system),
    sessionId: state.sessionId,
  };

  if (
    state.config.user &&
    typeof state.config.user.name === 'string' &&
    state.config.user.name.length > 0
  ) {
    initPayload.userName = state.config.user.name;
  }
  if (state.config.applicationId) initPayload.applicationId = state.config.applicationId;
  if (state.config.environment) initPayload.environment = state.config.environment;

  // Initial page URL
  try {
    initPayload.initialUrl =
      typeof window !== 'undefined' && window.location ? window.location.href : null;
  } catch (_) {
    initPayload.initialUrl = null;
  }

  const response = await fetch(`${state.config.collectorUrl}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: safeStringify(initPayload),
  });

  if (!response.ok) {
    console.error('VoidrCollector: init failed with status', response.status);
    return false;
  }

  const data = await response.json().catch(() => ({}));
  state.authToken = data.token || null;
  if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
    state.sessionId = data.sessionId.trim();
  }
  if (!state.authToken) {
    console.error('VoidrCollector: Failed to get authentication token');
    return false;
  }

  // Persist JWT and session ID for reuse on re-init (e.g. page reload)
  try {
    sessionStorage.setItem('voidr_jwt', state.authToken);
    sessionStorage.setItem('voidr_session_id', state.sessionId);
    if (state.userId) {
      sessionStorage.setItem('voidr_user_id', state.userId);
    }
  } catch (_) { }

  return true;
}
