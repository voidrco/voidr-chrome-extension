import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import OrganizationCard from './components/OrganizationCard';
import AuthApp from './components/Auth/AuthApp';
import './App.css';
import './popup.css';

type View = 'welcome' | 'testPlanning' | 'defects';

function App() {
  const [view, setView] = useState<View>('welcome');
  const [authState, setAuthState] = useState<{ loading: boolean; authenticated: boolean }>({
    loading: true,
    authenticated: false,
  });

  // Inline auth routing inside popup
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { voidrAuth } = await chrome.storage.local.get(['voidrAuth']);
        const ok = !!(voidrAuth?.token && voidrAuth?.expiresAt > Date.now());
        if (mounted) setAuthState({ loading: false, authenticated: ok });
      } catch {
        if (mounted) setAuthState({ loading: false, authenticated: false });
      }
    })();
    const listener = (req: any) => {
      if (req?.action === 'authCompleted') setAuthState({ loading: false, authenticated: true });
      if (req?.action === 'authLogout') setAuthState({ loading: false, authenticated: false });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const handleSync = useCallback(async () => {
    try {
      // placeholder: integrar com services conforme migração
      console.log('Sync requested');
    } catch (e) {
      console.error('Sync failed', e);
    }
  }, []);

  const tabs = useMemo(
    () => [
      { id: 'welcome', label: 'Welcome' },
      { id: 'testPlanning', label: 'Test Planning' },
      { id: 'defects', label: 'Defects' },
    ] as Array<{ id: View; label: string }>,
    [],
  );

  if (!authState.loading && !authState.authenticated) {
    return (
      <div style={{ minWidth: 360 }}>
        <AuthApp />
      </div>
    );
  }

  return (
    <div className="extension-container">
      <Header onSync={handleSync} />
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`tab-btn ${view === t.id ? 'active' : ''}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="extension-content">
        {view === 'welcome' && (
          <>
            <OrganizationCard />
            <div>Welcome</div>
          </>
        )}
        {view === 'testPlanning' && <div>Test Planning</div>}
        {view === 'defects' && <div>Defects</div>}
      </div>
      <div className="extension-footer">
        <div className="version">v2</div>
      </div>
    </div>
  );
}

export default App;
