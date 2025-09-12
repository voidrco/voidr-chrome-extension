import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getEnv } from '../../../../src/core/env';
import '../../popup.css';

type View = 'checking' | 'login' | 'authenticated' | 'error';

export default function AuthApp() {
  const env = getEnv();
  const [view, setView] = useState<View>('checking');
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected' | 'error'>('checking');
  const [statusText, setStatusText] = useState('Checking connection...');
  const [user, setUser] = useState<any>(null);
  const api = useMemo(() => ({
    baseUrl: env.VOIDR_API_BASE_URL as string,
    platformUrl: env.VOIDR_PLATFORM_URL as string,
    auth0Domain: env.VOIDR_AUTH0_DOMAIN as string,
    auth0ClientId: env.VOIDR_AUTH0_CLIENT_ID as string,
    auth0Audience: env.VOIDR_AUTH0_AUDIENCE as string,
  }), [env]);

  const cacheKey = useMemo(() => `@@auth0spajs@@::${api.auth0ClientId}::${api.auth0Audience}::openid profile email`, [api]);

  const updateStatus = useCallback((type: typeof status, text: string) => {
    setStatus(type);
    setStatusText(text);
  }, []);

  const getStoredAuth = useCallback(async () => {
    const { voidrAuth } = await chrome.storage.local.get(['voidrAuth']);
    return (voidrAuth as any) || null;
  }, []);

  const storeAuth = useCallback(async (token: string, u: any) => {
    const payload = { token, user: u, isAuthenticated: true, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    await chrome.storage.local.set({ voidrAuth: payload });
  }, []);

  const clearStoredAuth = useCallback(async () => {
    await chrome.storage.local.remove(['voidrAuth']);
  }, []);

  const validateToken = useCallback(async (token: string) => {
    try {
      const me = await fetch(`${api.baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (!me.ok) return { isValid: false };
      const authData = await me.json();
      try {
        const profile = await fetch(`${api.baseUrl}/profile/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (profile.ok) {
          const prof = await profile.json();
          return { isValid: true, user: { ...authData?.data, profile: prof?.data } };
        }
      } catch {}
      return { isValid: true, user: authData?.data };
    } catch {
      return { isValid: false };
    }
  }, [api.baseUrl]);

  const getTokenFromPlatform = useCallback(async () => {
    const tabs = await chrome.tabs.query({ url: `${api.platformUrl}/*` });
    if (!tabs.length || !tabs[0]?.id) return null as string | null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (ck: string) => {
        try {
          const raw = localStorage.getItem(ck);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          return parsed?.body?.access_token || null;
        } catch {
          return null;
        }
      },
      args: [cacheKey],
    });
    return (results?.[0]?.result as string) || null;
  }, [api.platformUrl, cacheKey]);

  const checkAuth = useCallback(async () => {
    updateStatus('checking', 'Checking authentication...');
    setView('checking');
    try {
      const stored = await getStoredAuth();
      if (stored?.token && stored.expiresAt > Date.now()) {
        const valid = await validateToken(stored.token);
        if (valid.isValid) {
          await storeAuth(stored.token, valid.user);
          chrome.runtime.sendMessage({ action: 'authCompleted', authData: { token: stored.token, user: valid.user, isAuthenticated: true } });
          setUser(valid.user);
          updateStatus('connected', 'Connected');
          setView('authenticated');
          return;
        }
        await clearStoredAuth();
      }

      const platformToken = await getTokenFromPlatform();
      if (platformToken) {
        const valid = await validateToken(platformToken);
        if (valid.isValid) {
          await storeAuth(platformToken, valid.user);
          chrome.runtime.sendMessage({ action: 'authCompleted', authData: { token: platformToken, user: valid.user, isAuthenticated: true } });
          setUser(valid.user);
          updateStatus('connected', 'Connected');
          setView('authenticated');
          return;
        }
      }

      updateStatus('disconnected', 'Not authenticated');
      setView('login');
    } catch (e: any) {
      updateStatus('error', 'Connection error');
      setView('error');
    }
  }, [updateStatus, getStoredAuth, validateToken, clearStoredAuth, getTokenFromPlatform, storeAuth]);

  useEffect(() => {
    checkAuth();
    const onMsg = (req: any) => {
      if (req?.action === 'checkAuth') checkAuth();
      if (req?.action === 'forceLogout') onLogout();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [checkAuth]);

  const onOpenPlatform = useCallback(() => {
    chrome.runtime.sendMessage({ action: 'openPlatformForAuth' });
  }, []);
  const onRetry = useCallback(() => checkAuth(), [checkAuth]);
  const onContinue = useCallback(() => { window.close(); chrome.runtime.sendMessage({ action: 'authCompleted' }); }, []);
  const onLogout = useCallback(async () => {
    await clearStoredAuth();
    chrome.runtime.sendMessage({ action: 'authLogout' });
    updateStatus('disconnected', 'Not authenticated');
    setView('login');
  }, [clearStoredAuth, updateStatus]);

  const name = user?.profile?.fullName || user?.name || user?.email || 'User';
  const email = user?.email || user?.profile?.email || '';

  return (
    <div className="voidr-welcome">
      <div className="voidr-welcome-header">
        <div className="voidr-welcome-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <path d="M9 12l2 2 4-4"></path>
          </svg>
        </div>
        <h2>Authentication Required</h2>
        <p>To use the Testing Assistant, you need to login to the Voidr platform.</p>
      </div>

      {view === 'checking' && (
        <div className="auth-state" id="checking-state">
          <div className="loading-spinner"></div>
          <h2>Connecting to Voidr platform</h2>
          <p>Checking if you are already authenticated...</p>
        </div>
      )}

      {view === 'login' && (
        <div className="voidr-welcome-actions">
          <div className="voidr-action-cards">
            <button className="voidr-action-card" id="login-to-voidr-btn" onClick={onOpenPlatform}>
              <div className="voidr-action-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                  <polyline points="10,17 15,12 10,7"></polyline>
                  <line x1="15" y1="12" x2="3" y2="12"></line>
                </svg>
              </div>
              <div className="voidr-action-content">
                <h4>Login to Voidr</h4>
                <p>Opens the Voidr platform for authentication</p>
              </div>
              <div className="voidr-action-arrow">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9,18 15,12 9,6"></polyline>
                </svg>
              </div>
            </button>
          </div>
        </div>
      )}

      {view === 'authenticated' && (
        <div className="auth-state" id="authenticated-state">
          <div className="success-icon"><span className="icon-check-circle-2"></span></div>
          <h2>Successfully connected!</h2>
          <p>You are authenticated on the Voidr platform.</p>
          <div className="user-info" id="user-info">
            <div className="user-avatar" id="user-avatar"><span className="icon-user"></span></div>
            <div className="user-details">
              <span className="user-name" id="user-name">{name}</span>
              <span className="user-email" id="user-email">{email}</span>
            </div>
          </div>
          <div className="auth-actions">
            <button id="continue-btn" className="btn-primary" onClick={onContinue}>
              <span className="icon-chevron-right"></span>
              Continue to Extension
            </button>
            <button id="logout-btn" className="btn-secondary" onClick={onLogout}>
              <span className="icon-log-out"></span>
              Logout
            </button>
          </div>
        </div>
      )}

      {view === 'error' && (
        <div className="auth-state" id="error-state">
          <div className="error-icon"><span className="icon-alert-circle"></span></div>
          <h2>Connection error</h2>
          <p id="error-message">Could not connect to the Voidr platform.</p>
          <div className="auth-actions">
            <button id="retry-connection-btn" className="btn-primary" onClick={onRetry}>
              <span className="icon-refresh-cw"></span>
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


