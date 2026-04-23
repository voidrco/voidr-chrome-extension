// Background script para a extensão Voidr Testing Assistant

// Carrega variáveis de ambiente, se disponíveis
try {
  importScripts('config/env.js');
} catch (_) {
  try {
    importScripts('../config/env.js');
  } catch (__) {}
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
  auth0Domain: __ENV__.VOIDR_AUTH0_DOMAIN || DEFAULTS.auth0Domain,
  auth0ClientId: __ENV__.VOIDR_AUTH0_CLIENT_ID || DEFAULTS.auth0ClientId,
  auth0Audience: __ENV__.VOIDR_AUTH0_AUDIENCE || DEFAULTS.auth0Audience,
};

const API_CONFIG = {
  baseUrl: RESOLVED.baseUrl,
  platformUrl: RESOLVED.platformUrl,
  collectorUrl: RESOLVED.collectorUrl,
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

// Active recording state — survives page navigations within the recorded tab
let activeRecording = null;
// Guard against race condition: if onUpdated fires before sessionStopped is dequeued
let lastStoppedAt = 0;

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

// Hydrate auth state whenever the service worker starts up
// MV3 service workers are ephemeral; don't rely on in-memory state
checkAuthenticationStatus();

// Also re-check on browser startup
chrome.runtime.onStartup.addListener(() => {
  checkAuthenticationStatus();
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
  if (areaName === 'local' && changes.voidrAuth) {
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

// Listener para mensagens dos content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'voidr:injectCollectorAndInit':
      (async () => {
        try {
          // Decide target tab: prefer sender.tab.id, else lastActiveContentTabId, else find an http(s) tab
          let targetTabId = sender?.tab?.id || lastActiveContentTabId;
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

          // Fetch official collector from CDN (cache-busted)
          const cdnUrl =
            'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js?v=' + Date.now();
          // const cdnUrl =
          //   'http://localhost:8889/dist/recorder.min.js?v=' + Date.now();
          const res = await fetch(cdnUrl);
          if (!res.ok) throw new Error(`Failed to fetch collector: ${res.status}`);
          const code = await res.text();

          // Inject code into MAIN world (bypasses page CSP element restrictions)
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: 'MAIN',
            func: (collectorCode) => {
              try {
                (0, eval)(collectorCode);
              } catch (e) {
                console.error('[Voidr] Collector eval error', e);
              }
            },
            args: [code],
          });

          // Initialize collector with provided options
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: 'MAIN',
            func: (opts) => {
              try {
                window.VoidrCollector &&
                  window.VoidrCollector.init &&
                  window.VoidrCollector.init(opts);
              } catch (e) {
                console.error('[Voidr] Collector init error', e);
              }
            },
            args: [{ ...(request.initOptions || {}), collectorUrl: API_CONFIG.collectorUrl }],
          });

          // Retrieve sessionId after init and broadcast to extension UIs
          try {
            const res = await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              world: 'MAIN',
              func: () => {
                try {
                  return (
                    (window.VoidrCollector &&
                      window.VoidrCollector.getSessionId &&
                      window.VoidrCollector.getSessionId()) ||
                    null
                  );
                } catch (_) {
                  return null;
                }
              },
            });
            const sessionId = (res && res[0] && res[0].result) || null;
            try {
              chrome.runtime.sendMessage({
                action: 'voidr:sessionStarted',
                sessionId: sessionId,
                testCaseName:
                  (request.initOptions &&
                    request.initOptions.meta &&
                    request.initOptions.meta.testCase) ||
                  null,
                mode:
                  (request.initOptions &&
                    request.initOptions.meta &&
                    request.initOptions.meta.mode) ||
                  'test-case',
              });
            } catch (_) {}
          } catch (_) {}

          let targetOrigin = null;
          try {
            const tabInfo = await chrome.tabs.get(targetTabId);
            if (tabInfo?.url) targetOrigin = new URL(tabInfo.url).origin;
          } catch (_) {}

          activeRecording = {
            tabId: targetTabId,
            targetOrigin,
            initOptions: { ...(request.initOptions || {}), collectorUrl: API_CONFIG.collectorUrl },
            testCaseName: request.initOptions?.meta?.testCase || 'Test Case',
            mode: request.initOptions?.meta?.mode || 'test-case',
            onboardingRunId: request.initOptions?.meta?.onboardingRunId,
            flows: request.initOptions?.meta?.flows || [],
            sessionIds: sessionId ? [sessionId] : [],
          };

          sendResponse({ success: true });
        } catch (e) {
          console.error('Collector injection error:', e);
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
            chrome.storage.session.set({ pendingOnboardingContext: json.data });
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

    case 'apiRequest':
      // Faz requisições autenticadas para a API
      (async () => {
        if (!globalAuthState.isAuthenticated || !globalAuthState.token) {
          await checkAuthenticationStatus();
        }

        if (!globalAuthState.isAuthenticated || !globalAuthState.token) {
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
          sendResponse({ found: res.ok });
        } catch (_) {
          sendResponse({ found: false });
        }
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
          sendResponse({ success: false, error: 'No content tab to forward to' });
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
            await new Promise((r) => setTimeout(r, 100));
            await chrome.tabs.sendMessage(targetTabId, payload);
            sendResponse({ success: true, forwarded: true, injected: true, tabId: targetTabId });
          } catch (e2) {
            sendResponse({ success: false, error: e2?.message || 'Failed to send message' });
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
            await new Promise((r) => setTimeout(r, 100));
            await chrome.tabs.sendMessage(targetTabId, payload);
          }
          sendResponse({ success: true, tabId: targetTabId });
        } catch (e) {
          sendResponse({ success: false, error: e?.message || 'Failed to forward to target tab' });
        }
      })();
      return true;

    case 'voidr:sessionStopped':
      lastStoppedAt = Date.now();
      const priorSessionIds = activeRecording?.sessionIds || [];
      activeRecording = null;
      // On stop, try to retrieve the current sessionId from the page and broadcast all accumulated sessions
      (async () => {
        try {
          let targetTabId = sender?.tab?.id || lastActiveContentTabId;
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
            sendResponse({ success: false, error: 'No eligible tab to get sessionId' });
            return;
          }
          const res = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: 'MAIN',
            func: () => {
              try {
                return (
                  (window.VoidrCollector &&
                    window.VoidrCollector.getSessionId &&
                    window.VoidrCollector.getSessionId()) ||
                  null
                );
              } catch (_) {
                return null;
              }
            },
          });
          const sessionId = (res && res[0] && res[0].result) || null;
          const activeRunId = request.onboardingRunId || null;

          // Merge current sessionId with all previously accumulated ones
          const allSessionIds = [...new Set([...priorSessionIds, sessionId].filter(Boolean))];

          // Broadcast voidr:sessionCaptured for EACH accumulated sessionId
          for (const sid of allSessionIds) {
            const capturedPayload = {
              action: 'voidr:sessionCaptured',
              sessionId: sid,
              onboardingRunId: activeRunId,
            };
            try {
              chrome.runtime.sendMessage(capturedPayload);
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
                      },
                    ],
                  })
                  .catch(() => {});
              }
            } catch (_) {}
          }

          // After broadcasting, request the collector to end the session
          try {
            await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              world: 'MAIN',
              func: () => {
                try {
                  window.VoidrCollector &&
                    window.VoidrCollector.endSession &&
                    window.VoidrCollector.endSession();
                } catch (_) {}
              },
            });
          } catch (_) {}

          sendResponse({ success: true, sessionId, sessionIds: allSessionIds });
        } catch (e) {
          sendResponse({
            success: false,
            error: e?.message || 'Failed to retrieve sessionId on stop',
          });
        }
      })();
      return true;
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
});

// Faz requisições autenticadas para a API
async function makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
  try {
    console.log('[API] →', method, endpoint, data ? JSON.stringify(data).slice(0, 500) : '');
    const options = {
      method: method,
      headers: {
        Authorization: `Bearer ${globalAuthState.token}`,
        'Content-Type': 'application/json',
      },
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }

    const url = `${API_CONFIG.baseUrl}${endpoint}`;
    const response = await fetch(url, options);

    if (!response.ok) {
      if (response.status === 401) {
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
      console.warn('[API] ←', method, endpoint, response.status, response.statusText, bodyText);
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
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
  // Re-inject collector + recording UI when the recorded tab navigates within the target domain
  if (
    changeInfo.status === 'complete' &&
    activeRecording &&
    tabId === activeRecording.tabId &&
    tab.url &&
    /^https?:/i.test(tab.url) &&
    (!activeRecording.targetOrigin || tab.url.startsWith(activeRecording.targetOrigin)) &&
    Date.now() - lastStoppedAt > 2000
  ) {
    try {
      // const cdnUrl = 'http://localhost:8889/dist/recorder.min.js?v=' + Date.now();
      const cdnUrl =
        'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js?v=' + Date.now();
      const res = await fetch(cdnUrl);
      if (res.ok) {
        const code = await res.text();
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (collectorCode) => {
            try {
              (0, eval)(collectorCode);
            } catch (_) {}
          },
          args: [code],
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (opts) => {
            try {
              window.VoidrCollector?.init?.(opts);
            } catch (_) {}
          },
          args: [activeRecording.initOptions],
        });
        chrome.tabs
          .sendMessage(tabId, {
            action: 'voidr:resumeRecordingUI',
            testCaseName: activeRecording.testCaseName,
            mode: activeRecording.mode,
            onboardingRunId: activeRecording.onboardingRunId,
            flows: activeRecording.flows,
            applicationId: activeRecording.initOptions?.applicationId || null,
          })
          .catch(() => {});

        // Capture the new sessionId after init() completes (~3s for async auth + sleep(2000))
        const captureTabId = tabId;
        setTimeout(async () => {
          try {
            const sidRes = await chrome.scripting.executeScript({
              target: { tabId: captureTabId },
              world: 'MAIN',
              func: () => {
                try {
                  return window.VoidrCollector?.getSessionId?.() || null;
                } catch (_) {
                  return null;
                }
              },
            });
            const newSid = sidRes?.[0]?.result || null;
            if (newSid && activeRecording && !activeRecording.sessionIds.includes(newSid)) {
              activeRecording.sessionIds.push(newSid);
            }
          } catch (_) {}
        }, 3500);
      }
    } catch (_) {}
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
        chrome.runtime.sendMessage({
          action: 'authenticationCompleted',
          user: globalAuthState.user,
        });
      }, 3000);
    } else {
      // Sincronização normal para outras páginas
      setTimeout(async () => {
        await syncAuthWithPlatform(tabId);
      }, 2000);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeRecording && activeRecording.tabId === tabId) {
    activeRecording = null;
  }
});

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
