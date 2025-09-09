// Background script para a extensão Voidr Testing Assistant

// Carrega variáveis de ambiente, se disponíveis
try {
  importScripts('config/env.js');
} catch (e) {
  console.error('Error importing env.js:', e);
  importScripts('../config/env.js');
}

// Configurações da API - com overrides via __VOIDR_ENV__
const __ENV__ = (typeof globalThis !== 'undefined' && globalThis.__VOIDR_ENV__) || {};
const DEFAULTS = {
  baseUrl: 'https://voidr-service-785568282479.us-central1.run.app/v1',
  platformUrl: 'https://canary.voidr.co',
  auth0Domain: 'bounties4.us.auth0.com',
  auth0ClientId: 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS',
  auth0Audience: 'https://service.bounties4.com/',
};

const RESOLVED = {
  baseUrl: __ENV__.VOIDR_API_BASE_URL || DEFAULTS.baseUrl,
  platformUrl: __ENV__.VOIDR_PLATFORM_URL || DEFAULTS.platformUrl,
  auth0Domain: __ENV__.VOIDR_AUTH0_DOMAIN || DEFAULTS.auth0Domain,
  auth0ClientId: __ENV__.VOIDR_AUTH0_CLIENT_ID || DEFAULTS.auth0ClientId,
  auth0Audience: __ENV__.VOIDR_AUTH0_AUDIENCE || DEFAULTS.auth0Audience,
};

const API_CONFIG = {
  baseUrl: RESOLVED.baseUrl,
  platformUrl: RESOLVED.platformUrl,
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

// Helpers to persist assistant window id across service worker restarts
async function getStoredAssistantWindowId() {
  const res = await chrome.storage.local.get(['assistantWindowId']);
  return res.assistantWindowId || null;
}
async function setStoredAssistantWindowId(id) {
  await chrome.storage.local.set({ assistantWindowId: id || null });
}
async function clearStoredAssistantWindowId(id) {
  const current = await getStoredAssistantWindowId();
  if (!id || current === id) await chrome.storage.local.remove(['assistantWindowId']);
}

// On window removed, clear stored id if it matches
chrome.windows.onRemoved.addListener(async (removedId) => {
  if (lastPopupWindowId === removedId) lastPopupWindowId = null;
  await clearStoredAssistantWindowId(removedId);
});

async function focusExistingAssistantWindow() {
  // 1) Try memory id
  if (lastPopupWindowId) {
    await chrome.windows.update(lastPopupWindowId, { focused: true, drawAttention: true });
    return lastPopupWindowId;
  }
  // 2) Try stored id
  const storedId = await getStoredAssistantWindowId();
  if (storedId) {
    try {
      await chrome.windows.update(storedId, { focused: true, drawAttention: true });
      lastPopupWindowId = storedId;
      return storedId;
    } catch (e) {
      console.error('Error focusing existing assistant window:', e);
      await clearStoredAssistantWindowId(storedId);
    }
  }
  // 3) Scan all windows by URL
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup', 'normal'] });
  const targetUrl = chrome.runtime.getURL('popup/popup.html');
  for (const w of wins) {
    const match = (w.tabs || []).find((tab) => tab.url && tab.url.startsWith(targetUrl));
    if (match) {
      await chrome.tabs.update(match.id, { active: true });
      await chrome.windows.update(w.id, { focused: true, drawAttention: true });
      lastPopupWindowId = w.id;
      await setStoredAssistantWindowId(w.id);
      return w.id;
    }
  }
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
  } catch (e) {
    console.error('Error checking if URL is HTTP:', e);
    return false;
  }
}

async function resolveReturnUrl() {
  // 1) Prefer lastActiveContentTabId
  if (lastActiveContentTabId) {
    const tab = await chrome.tabs.get(lastActiveContentTabId);
    if (tab && isHttpUrl(tab.url)) return tab.url;
  }
  // 2) Active tab in focused window
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const t = tabs && tabs[0];
  if (t && isHttpUrl(t.url)) return t.url;
  // 3) Any http(s) tab across windows
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  for (const w of wins) {
    const httpTab = (w.tabs || []).find((tab) => isHttpUrl(tab.url));
    if (httpTab) return httpTab.url;
  }
  // 4) Stored fallback
  const stored = await chrome.storage.local.get(['lastActiveContentUrl']);
  if (isHttpUrl(stored.lastActiveContentUrl)) return stored.lastActiveContentUrl;
  return '';
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

  // Abre a janela flutuante por padrão após instalação/atualização (DX)
  chrome.runtime.sendMessage({ action: 'openFloatingPopup' }).catch(() => {});
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

// Abre página de autenticação
function openAuthPage() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('auth/auth.html'),
    active: true,
  });
}

// Listener para mensagens dos content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Mensagem recebida no background:', request);

  switch (request.action) {
    case 'voidr:injectCollectorAndInit':
      (async () => {
        try {
          // Decide target tab: prefer sender.tab.id, else lastActiveContentTabId, else find an http(s) tab
          let targetTabId = sender?.tab?.id || lastActiveContentTabId;
          if (!targetTabId) {
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
          }
          if (!targetTabId) {
            sendResponse({ success: false, error: 'No eligible tab for injection' });
            return;
          }

          // Fetch official collector from CDN (cache-busted)
          const cdnUrl =
            'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js?v=' + Date.now();
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
            args: [request.initOptions || {}],
          });

          // Retrieve sessionId after init and broadcast to extension UIs
          const res2 = await chrome.scripting.executeScript({
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
              } catch (e) {
                console.error('Error getting sessionId:', _);
                return null;
              }
            },
          });
          const sessionId = (res2 && res2[0] && res2[0].result) || null;
          chrome.runtime.sendMessage({
            action: 'voidr:sessionStarted',
            sessionId: sessionId,
            testCaseName:
              (request.initOptions &&
                request.initOptions.meta &&
                request.initOptions.meta.testCase) ||
              null,
            mode:
              (request.initOptions && request.initOptions.meta && request.initOptions.meta.mode) ||
              'test-case',
          });

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

    case 'requireAuth':
      // Abre página de autenticação se não estiver autenticado
      if (!globalAuthState.isAuthenticated) {
        openAuthPage();
        sendResponse({ authRequired: true });
      } else {
        sendResponse({ authRequired: false, token: globalAuthState.token });
      }
      return true;

    case 'openPlatformForAuth':
      // Abre plataforma com URL de retorno da aba atual
      console.log('Background: Received openPlatformForAuth request');
      (async () => {
        const currentUrl = await resolveReturnUrl();
        const returnUrl = encodeURIComponent(currentUrl || '');
        console.log('Opening platform for auth with return URL:', currentUrl);
        const connectUrl = `${API_CONFIG.platformUrl}/auth/extension-connect?returnTo=${returnUrl}`;
        console.log('Connect URL:', connectUrl);
        try {
          const tab = await chrome.tabs.create({ url: connectUrl, active: true });
          sendResponse({ success: true, tabId: tab?.id });
        } catch (e) {
          sendResponse({ success: false, error: e?.message || 'Failed to open auth tab' });
        }
      })();
      return true; // Indica resposta assíncrona

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

    case 'injectWidget':
      // Injeta o widget na aba ativa
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            files: ['widget/widget.js'],
          });
        }
      });
      break;

    case 'openFloatingPopup':
      // Persiste URL atual para manter contexto na janela flutuante
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
        const t = tabs && tabs[0] ? tabs[0] : null;
        const url = t && t.url && /^https?:/i.test(t.url) ? t.url : '';
        if (t && t.id && /^https?:/i.test(t.url || '')) {
          lastActiveContentTabId = t.id;
        }
        await chrome.storage.local.set({ lastActiveContentUrl: url });

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

    case 'browserActionClicked':
      // Ao clicar no ícone, abrir a janela flutuante por padrão
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs && tabs[0] ? tabs[0] : null;
        if (t && t.id && /^https?:/i.test(t.url || '')) {
          lastActiveContentTabId = t.id;
        }
        chrome.runtime.sendMessage({ action: 'openFloatingPopup' }).catch(() => {});
      });
      sendResponse({ success: true });
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
          } catch (e) {
            throw e;
          }
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
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            files: ['content/content.js'],
          });
          await new Promise((r) => setTimeout(r, 100));
          await chrome.tabs.sendMessage(targetTabId, payload);
          sendResponse({ success: true, forwarded: true, injected: true, tabId: targetTabId });
        }
      })();
      return true;
    case 'voidr:sessionStopped':
      // On stop, try to retrieve the current sessionId from the page and broadcast it
      (async () => {
        try {
          let targetTabId = sender?.tab?.id || lastActiveContentTabId;
          if (!targetTabId) {
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
                console.error('Error getting sessionId:', _);
                return null;
              }
            },
          });
          const sessionId = (res && res[0] && res[0].result) || null;
          chrome.runtime.sendMessage({ action: 'voidr:sessionCaptured', sessionId });

          // After broadcasting, request the collector to end the session
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: 'MAIN',
            func: () => {
              window.VoidrCollector &&
                window.VoidrCollector.endSession &&
                window.VoidrCollector.endSession();
            },
          });

          sendResponse({ success: true, sessionId });
        } catch (e) {
          sendResponse({
            success: false,
            error: e?.message || 'Failed to retrieve sessionId on stop',
          });
        }
      })();
      return true;
    case 'focusOrOpenPopup':
      // Focus existing popup, or create a new one at provided position
      (async () => {
        const desired = request.position || {};
        const specs = {
          url: chrome.runtime.getURL('popup/popup.html'),
          type: 'popup',
          width: 472,
          height: 625,
          focused: true,
        };
        if (typeof desired.left === 'number') specs.left = Math.max(0, desired.left);
        if (typeof desired.top === 'number') specs.top = Math.max(0, desired.top);

        const focusExisting = async (winId) => {
          if (!winId && lastPopupWindowId) winId = lastPopupWindowId;
          if (!winId) return false;
          await chrome.windows.update(winId, { focused: true, drawAttention: true });
          return true;
        };

        let focused = await focusExisting(request.windowId || lastPopupWindowId);
        if (!focused) {
          // Try to find any existing assistant popup by URL
          const wins = await chrome.windows.getAll({
            populate: true,
            windowTypes: ['popup', 'normal'],
          });
          const targetUrl = chrome.runtime.getURL('popup/popup.html');
          let existing = null;
          for (const w of wins) {
            const match = (w.tabs || []).find((t) => t.url && t.url.startsWith(targetUrl));
            if (match) {
              existing = w;
              break;
            }
          }
          if (existing && existing.id) {
            lastPopupWindowId = existing.id;
            const tab = (existing.tabs || []).find((t) => t.url && t.url.startsWith(targetUrl));
            if (tab && tab.id) await chrome.tabs.update(tab.id, { active: true });
            focused = await focusExisting(existing.id);
          }
        }
        if (focused) {
          sendResponse({ success: true, refocused: true, windowId: lastPopupWindowId });
          return;
        }

        chrome.windows.create(specs, (createdWin) => {
          lastPopupWindowId = createdWin?.id || null;
          sendResponse({ success: true, created: true, windowId: createdWin?.id });
        });
      })();
      return true;

    case 'prepareExtensionReopen':
      // Prepara para reabrir a extensão após redirect
      chrome.storage.local.set({
        shouldReopenExtension: true,
        reopenTimestamp: Date.now(),
      });
      console.log('Extension reopen prepared');
      break;

    default:
      console.log('Ação não reconhecida:', request.action);
  }
});

// Listener para mudanças de aba
chrome.tabs.onActivated.addListener((activeInfo) => {
  console.log('Aba ativada:', activeInfo.tabId);
  // Atualiza última aba http(s) ativa
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab && tab.id && tab.url && /^https?:/i.test(tab.url)) {
      lastActiveContentTabId = tab.id;
    }
  });
});

// Listener para atualizações de URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('Página carregada:', tab.url);
    // Aqui podemos implementar lógica para auto-injeção do widget
  }
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
      bodyText = await response.text();
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

// Check if extension should be reopened after auth
async function checkAndReopenExtension() {
  try {
    const result = await chrome.storage.local.get(['shouldReopenExtension', 'reopenTimestamp']);

    if (result.shouldReopenExtension && result.reopenTimestamp) {
      // Only reopen if less than 10 minutes have passed
      const timeDiff = Date.now() - result.reopenTimestamp;
      if (timeDiff < 10 * 60 * 1000) {
        console.log('Reopening extension popup after authentication...');

        // Clear the flag
        await chrome.storage.local.remove(['shouldReopenExtension', 'reopenTimestamp']);

        // Open extension popup
        chrome.action.openPopup().catch((error) => {
          console.log('Could not reopen popup automatically:', error);
          // Fallback: show notification
          chrome.notifications
            .create({
              type: 'basic',
              iconUrl: 'icons/icon48.png',
              title: 'Voidr Extension',
              message: 'Authentication successful! Click the extension icon to continue.',
            })
            .catch(() => {
              // Ignore notification errors
            });
        });
      } else {
        // Clean up old flag
        await chrome.storage.local.remove(['shouldReopenExtension', 'reopenTimestamp']);
      }
    }
  } catch (error) {
    console.error('Error checking extension reopen:', error);
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
    await chrome.storage.local.set({ lastActiveContentUrl: url });

    const existingId = await focusExistingAssistantWindow();
    if (existingId) return;
    await openAssistantWindowAt();
  });
});

// Listener para detectar quando a plataforma Voidr é acessada
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
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
          .catch(() => {
            // Ignora erros se não há listeners
          });

        // Check if extension should be reopened
        await checkAndReopenExtension();
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
