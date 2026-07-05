import { state } from './state.js';
import { safeStringify } from './utils/helpers.js';

/**
 * SessionEnvironmentBundle (phase-2 groundwork for local Playwright replay).
 *
 * At recording start — and refreshed on stop — we snapshot everything a local
 * `voidr replay --session <id>` needs to reconstruct the page state the tester
 * saw: localStorage, sessionStorage, non-HttpOnly cookies, the viewport, the
 * userAgent and the initial URL. The shape is Playwright's native
 * `storageState` (cookies + per-origin storage) so the replay CLI can feed it to
 * `browser.newContext({ storageState })` verbatim.
 *
 * SECURITY / SCOPE:
 *   - This payload CONTAINS SECRETS (auth cookies, tokens in localStorage). It is
 *     shipped to a DEDICATED collector endpoint and stored SEPARATELY from the
 *     replay artifacts served to the session player. It is never embedded in the
 *     rrweb chunk stream. See docs/journeys-experience/extension-contracts.md.
 *   - `document.cookie` only exposes NON-HttpOnly cookies, and without
 *     domain/path/expiry metadata. HttpOnly cookies (typically the real auth
 *     session) are captured out-of-band by the extension background via the
 *     chrome.cookies API and merged server-side. We therefore mark the cookies
 *     captured here `httpOnly: false` and default domain/path from the location.
 */

function readWebStorage(storage) {
  const out = [];
  if (!storage) return out;
  try {
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (name == null) continue;
      out.push({ name, value: storage.getItem(name) ?? '' });
    }
  } catch (_) {
    /* storage access can throw under strict privacy settings — best-effort */
  }
  return out;
}

function readDocumentCookies() {
  const cookies = [];
  try {
    const raw = document.cookie || '';
    if (!raw) return cookies;
    const host = window.location.hostname;
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name) continue;
      cookies.push({
        name,
        value,
        domain: host,
        path: '/',
        httpOnly: false, // document.cookie can only ever see non-HttpOnly cookies
        secure: window.location.protocol === 'https:',
      });
    }
  } catch (_) {
    /* best-effort */
  }
  return cookies;
}

/**
 * Build the page-context portion of the environment bundle. HttpOnly cookies are
 * intentionally absent (see module doc) — the extension supplies those.
 */
export function buildEnvironmentBundle() {
  let origin = '';
  let href = '';
  try {
    origin = window.location.origin;
    href = window.location.href;
  } catch (_) {}

  return {
    sessionId: state.sessionId,
    capturedAt: Date.now(),
    baseUrl: href || null,
    // NOTE: this script re-initializes on every navigation and also refreshes
    // the bundle on stop, so `href` here is only the TRUE entry url on the very
    // first write of the session. The collector-service merge is coordinated
    // with this: `initialUrl` is FIRST-write-wins server-side (a later write —
    // e.g. the stop refresh after navigation — never overwrites it), while
    // `baseUrl` keeps last-write semantics (latest page). See
    // mergeEnvironmentBundle in collector-service sessions.controller.js.
    initialUrl: href || null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    viewport: {
      width: typeof window !== 'undefined' ? window.innerWidth : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    },
    locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
    timezone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (_) {
        return undefined;
      }
    })(),
    storageState: {
      cookies: readDocumentCookies(),
      origins: [
        {
          origin,
          localStorage: readWebStorage(typeof window !== 'undefined' ? window.localStorage : null),
          sessionStorage: readWebStorage(
            typeof window !== 'undefined' ? window.sessionStorage : null,
          ),
        },
      ],
    },
    source: 'collector-script',
  };
}

/**
 * Capture and POST the environment bundle to the dedicated collector endpoint.
 * Gated by `config.captureEnvironmentBundle`. Best-effort and non-fatal:
 * recording never depends on this succeeding. Handles a 401 by refreshing the
 * collector token once (mirrors the chunk transport).
 */
export async function sendEnvironmentBundle() {
  if (!state.config.captureEnvironmentBundle) return;
  if (!state.sessionId || state.forceStop) return;

  // Snapshot everything we need SYNCHRONOUSLY. endSession() fires this and then
  // immediately resets state, so we must not read `state.*` after the first
  // await (sessionId/authToken/config would already be cleared).
  const bundle = buildEnvironmentBundle();
  const collectorUrl = state.config.collectorUrl;
  const apiKey = state.config.apiKey;
  const initialToken = state.authToken;
  const url = `${collectorUrl}/sessions/${encodeURIComponent(state.sessionId)}/environment-bundle`;
  const body = safeStringify(bundle);

  const post = (token) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });

  try {
    let res = await post(initialToken);

    if (res.status === 401) {
      const refreshResponse = await fetch(`${collectorUrl}/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeStringify({ apiKey }),
      });
      if (refreshResponse.ok) {
        const data = await refreshResponse.json().catch(() => ({}));
        state.authToken = data.token || null;
        if (state.authToken) {
          try {
            sessionStorage.setItem('voidr_jwt', state.authToken);
          } catch (_) {}
          res = await post(state.authToken);
        }
      }
    }

    if (!res.ok) {
      console.warn('VoidrCollector: environment bundle upload failed', res.status);
    }
  } catch (error) {
    console.warn('VoidrCollector: environment bundle upload error', error?.message || error);
  }
}
