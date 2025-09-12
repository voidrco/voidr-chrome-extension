import { getEnv } from '../src/core/env';

const DEFAULTS = {
  baseUrl: (getEnv() as any).VOIDR_API_BASE_URL as string,
  platformUrl: (getEnv() as any).VOIDR_PLATFORM_URL as string,
  auth0Domain: (getEnv() as any).VOIDR_AUTH0_DOMAIN as string,
  auth0ClientId: (getEnv() as any).VOIDR_AUTH0_CLIENT_ID as string,
  auth0Audience: (getEnv() as any).VOIDR_AUTH0_AUDIENCE as string,
};

export default defineBackground(() => {
  console.log('Voidr v2 background ready', { id: browser.runtime.id });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    (async () => {
      try {
        switch (request?.action) {
          case 'apiRequest': {
            const { endpoint, method = 'GET', data = null } = request;
            const token = await getStoredToken();
            const url = `${DEFAULTS.baseUrl}${endpoint}`;
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
            };
            if (token) headers.Authorization = `Bearer ${token}`;
            const res = await fetch(url, {
              method,
              headers,
              body: data ? JSON.stringify(data) : undefined,
            });
            const json = await safeJson(res);
            sendResponse({
              success: res.ok,
              status: res.status,
              data: json,
              error: !res.ok ? json?.message || res.statusText : undefined,
            });
            break;
          }
          case 'authCompleted': {
            const { authData } = request;
            await setStoredAuth({
              token: authData?.token || null,
              user: authData?.user || null,
            });
            sendResponse({ success: true });
            break;
          }
          case 'authLogout': {
            await clearStoredAuth();
            sendResponse({ success: true });
            break;
          }
          case 'openPlatformForAuth': {
            await chrome.tabs.create({ url: DEFAULTS.platformUrl });
            sendResponse({ success: true });
            break;
          }
          default:
            sendResponse({ success: false, error: 'Unknown action' });
        }
      } catch (e: any) {
        sendResponse({ success: false, error: e?.message || 'Unknown error' });
      }
    })();
    return true;
  });
});

async function getStoredToken(): Promise<string | null> {
  const { voidrAuth } = await chrome.storage.local.get(['voidrAuth']);
  if (voidrAuth && voidrAuth.token && voidrAuth.expiresAt > Date.now())
    return voidrAuth.token as string;
  return null;
}

async function setStoredAuth(data: { token: string | null; user: any | null }): Promise<void> {
  const payload = data?.token
    ? {
        token: data.token,
        user: data.user,
        isAuthenticated: true,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }
    : null;
  if (payload) await chrome.storage.local.set({ voidrAuth: payload });
}

async function clearStoredAuth(): Promise<void> {
  await chrome.storage.local.remove(['voidrAuth']);
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
