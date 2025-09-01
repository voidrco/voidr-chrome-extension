// Background script para a extensão Voidr Testing Assistant

// Configurações da API - Idêntico à aplicação
const API_CONFIG = {
  baseUrl: 'http://localhost:3000/v1',
  platformUrl: 'http://localhost:3030',
  auth0: {
    domain: 'bounties4.us.auth0.com',
    clientId: 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS',
    audience: 'https://service.bounties4.com/',
    cacheKey:
      '@@auth0spajs@@::c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS::https://service.bounties4.com/::openid profile email'
  }
};

// Estado global da autenticação
let globalAuthState = {
  isAuthenticated: false,
  user: null,
  token: null
};

// Listener para instalação da extensão
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Voidr Testing Assistant instalado:', details.reason);

  // Configurações iniciais
  chrome.storage.sync.set({
    voidrSettings: {
      widgetEnabled: true,
      apiEndpoint: 'http://localhost:3000/v1',
      theme: 'dark'
    }
  });

  // Verifica autenticação na instalação
  checkAuthenticationStatus();

  // Abre a janela flutuante por padrão após instalação/atualização (DX)
  chrome.runtime.sendMessage({ action: 'openFloatingPopup' }).catch(() => {});
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
          token: authData.token
        };
        console.log('User is authenticated:', isValid.user?.email);
      } else {
        console.log('Stored token is invalid, clearing...');
        await chrome.storage.local.remove(['voidrAuth']);
        globalAuthState = {
          isAuthenticated: false,
          user: null,
          token: null
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
        token: null
      };
      console.log('User is not authenticated');
    }
  } catch (error) {
    console.error('Error checking authentication:', error);
    globalAuthState = {
      isAuthenticated: false,
      user: null,
      token: null
    };
  }
}

// Abre página de autenticação
function openAuthPage() {
  chrome.tabs.create({
    url: chrome.runtime.getURL('auth/auth.html'),
    active: true
  });
}

// Listener para mensagens dos content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Mensagem recebida no background:', request);

  switch (request.action) {
    case 'getSettings':
      chrome.storage.sync.get(['voidrSettings'], (result) => {
        sendResponse(result.voidrSettings || {});
      });
      return true; // Indica resposta assíncrona

    case 'saveSettings':
      chrome.storage.sync.set(
        {
          voidrSettings: request.settings
        },
        () => {
          sendResponse({ success: true });
        }
      );
      return true;

    case 'getAuthStatus':
      // Retorna status de autenticação atual com token
      sendResponse({
        isAuthenticated: globalAuthState.isAuthenticated,
        user: globalAuthState.user,
        token: globalAuthState.token
      });
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
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentUrl = tabs[0]?.url || '';
        const returnUrl = encodeURIComponent(currentUrl);

        console.log('Opening platform for auth with return URL:', currentUrl);

        // Abre a rota específica da extensão com parâmetro de retorno
        const connectUrl = `${API_CONFIG.platformUrl}/auth/extension-connect?returnTo=${returnUrl}`;
        console.log('Connect URL:', connectUrl);

        chrome.tabs.create(
          {
            url: connectUrl,
            active: true
          },
          (newTab) => {
            console.log('New tab created:', newTab?.id);
            sendResponse({ success: true, tabId: newTab?.id });
          }
        );
      });
      return true; // Indica resposta assíncrona

    case 'authCompleted':
      // Atualiza estado global quando auth é concluída
      globalAuthState = {
        isAuthenticated: request.authData.isAuthenticated,
        user: request.authData.user,
        token: request.authData.token
      };
      console.log('Authentication completed for:', globalAuthState.user?.email);
      sendResponse({ success: true });
      break;

    case 'authLogout':
      // Limpa estado global no logout
      globalAuthState = {
        isAuthenticated: false,
        user: null,
        token: null
      };
      console.log('User logged out');
      sendResponse({ success: true });
      break;

    case 'apiRequest':
      // Faz requisições autenticadas para a API
      if (!globalAuthState.isAuthenticated || !globalAuthState.token) {
        sendResponse({ success: false, error: 'Not authenticated' });
        return true;
      }

      makeAuthenticatedRequest(request.endpoint, request.method || 'GET', request.data)
        .then((response) => {
          sendResponse({ success: true, data: response });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
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
            files: ['widget/widget.js']
          });
        }
      });
      break;

    case 'openFloatingPopup':
      // Persiste URL atual para manter contexto na janela flutuante
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
        const t = tabs && tabs[0] ? tabs[0] : null;
        const url = t && t.url && /^https?:/i.test(t.url) ? t.url : '';
        try {
          await chrome.storage.local.set({ lastActiveContentUrl: url });
        } catch (_) {}

        // Abre a interface em uma janela popup flutuante
        chrome.windows.create(
          {
            url: chrome.runtime.getURL('popup/popup.html'),
            type: 'popup',
            width: 760,
            height: 1000,
            focused: true
          },
          () => sendResponse({ success: true })
        );
      });
      return true;

    case 'browserActionClicked':
      // Ao clicar no ícone, abrir a janela flutuante por padrão
      chrome.runtime.sendMessage({ action: 'openFloatingPopup' }).catch(() => {});
      sendResponse({ success: true });
      return true;

    case 'prepareExtensionReopen':
      // Prepara para reabrir a extensão após redirect
      chrome.storage.local.set({
        shouldReopenExtension: true,
        reopenTimestamp: Date.now()
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
  // Aqui podemos implementar lógica para detectar mudanças de página
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
    const options = {
      method: method,
      headers: {
        Authorization: `Bearer ${globalAuthState.token}`,
        'Content-Type': 'application/json'
      }
    };

    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(`http://localhost:3000/v1${endpoint}`, options);

    if (!response.ok) {
      if (response.status === 401) {
        // Token expirado, limpa autenticação
        console.log('Token expired (401), clearing authentication...');
        globalAuthState = {
          isAuthenticated: false,
          user: null,
          token: null
        };
        await chrome.storage.local.remove(['voidrAuth']);

        // Notifica sobre expiração sem causar loop
        chrome.runtime
          .sendMessage({
            action: 'authExpired'
          })
          .catch(() => {
            // Ignora erros se não há listeners
          });

        throw new Error('Authentication expired');
      }
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json();
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
              message: 'Authentication successful! Click the extension icon to continue.'
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
setInterval(() => {
  checkAuthenticationStatus();
}, 30 * 60 * 1000);

// Quando o usuário clica no ícone da extensão, abre a janela flutuante
chrome.action.onClicked.addListener(() => {
  // Reutiliza a mesma lógica do caso 'openFloatingPopup'
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
    const t = tabs && tabs[0] ? tabs[0] : null;
    const url = t && t.url && /^https?:/i.test(t.url) ? t.url : '';
    try {
      await chrome.storage.local.set({ lastActiveContentUrl: url });
    } catch (_) {}

    chrome.windows.create(
      {
        url: chrome.runtime.getURL('popup/popup.html'),
        type: 'popup',
        width: 760,
        height: 1000,
        focused: true
      },
      () => {}
    );
  });
});

// Listener para detectar quando a plataforma Voidr é acessada
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http://localhost:3030')) {
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
          user: globalAuthState.user
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
              user: cacheData.body?.decodedToken?.user || null
            };
          }
          return null;
        } catch (e) {
          console.error('Error accessing platform auth:', e);
          return null;
        }
      },
      args: [API_CONFIG.auth0.cacheKey]
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
          token: platformAuth.token
        };

        // Armazena na extensão
        await chrome.storage.local.set({
          voidrAuth: {
            token: platformAuth.token,
            user: isValid.user,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            isAuthenticated: true
          }
        });

        console.log('Authentication synced with platform for:', isValid.user?.email);

        // Notifica todas as abas e popups sobre a autenticação
        chrome.runtime
          .sendMessage({
            action: 'authStateUpdated',
            authData: {
              isAuthenticated: true,
              user: isValid.user,
              token: platformAuth.token
            }
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
    const response = await fetch('http://localhost:3000/v1/auth/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
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
