// Script de autenticação para a extensão Voidr Testing Assistant

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
  },
  endpoints: {
    me: '/auth/me',
    profile: '/profile/me'
  }
};

// Estado da autenticação
let authState = {
  isAuthenticated: false,
  user: null,
  token: null,
  checking: true
};

// Elementos DOM
let elements = {};

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  console.log('Auth page loaded');
  initializeElements();
  setupEventListeners();
  checkAuthentication();
});

// Inicializa referências dos elementos DOM
function initializeElements() {
  elements = {
    // Estados
    checkingState: document.getElementById('checking-state'),
    loginState: document.getElementById('login-state'),
    authenticatedState: document.getElementById('authenticated-state'),
    errorState: document.getElementById('error-state'),

    // Status
    connectionStatus: document.getElementById('connection-status'),
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),

    // Botões
    openPlatformBtn: document.getElementById('open-platform-btn'),
    retryAuthBtn: document.getElementById('retry-auth-btn'),
    continueBtn: document.getElementById('continue-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    retryConnectionBtn: document.getElementById('retry-connection-btn'),

    // Informações do usuário
    userInfo: document.getElementById('user-info'),
    userAvatar: document.getElementById('user-avatar'),
    userName: document.getElementById('user-name'),
    userEmail: document.getElementById('user-email'),

    // Mensagens
    errorMessage: document.getElementById('error-message')
  };
}

// Configura event listeners
function setupEventListeners() {
  // Abrir plataforma Voidr
  elements.openPlatformBtn?.addEventListener('click', () => {
    openPlatformVoidr();
  });

  // Tentar autenticação novamente
  elements.retryAuthBtn?.addEventListener('click', () => {
    retryAuthentication();
  });

  // Continuar para extensão
  elements.continueBtn?.addEventListener('click', () => {
    continueToExtension();
  });

  // Logout
  elements.logoutBtn?.addEventListener('click', () => {
    logout();
  });

  // Tentar conexão novamente
  elements.retryConnectionBtn?.addEventListener('click', () => {
    retryConnection();
  });
}

// Verifica autenticação
async function checkAuthentication() {
  console.log('Checking authentication...');

  updateStatus('checking', 'Checking authentication...');
  showState('checking');

  try {
    // Primeiro, tenta buscar token armazenado
    const storedAuth = await getStoredAuth();

    if (storedAuth && storedAuth.token && storedAuth.expiresAt > Date.now()) {
      console.log('Found stored token, validating...');
      const validationResult = await validateToken(storedAuth.token);

      if (validationResult.isValid) {
        authState = {
          ...storedAuth,
          user: validationResult.user, // Atualiza com dados mais recentes
          token: storedAuth.token, // Mantém o token
          isAuthenticated: true,
          checking: false
        };

        // Atualiza storage com dados mais recentes
        await storeAuth({
          token: storedAuth.token,
          user: validationResult.user
        });

        showAuthenticatedState();
        return;
      } else {
        console.log('Stored token is invalid, clearing...');
        await clearStoredAuth();
      }
    } else if (storedAuth && storedAuth.expiresAt <= Date.now()) {
      console.log('Stored token is expired, clearing...');
      await clearStoredAuth();
    }

    // Se não tem token válido, tenta buscar da plataforma
    console.log('No valid token found, checking platform...');
    const platformAuth = await checkPlatformAuth();

    if (platformAuth && platformAuth.token) {
      console.log('Found valid platform authentication');
      await storeAuth(platformAuth);
      authState = {
        ...platformAuth,
        isAuthenticated: true,
        checking: false
      };

      // Notifica background script imediatamente
      chrome.runtime.sendMessage({
        action: 'authCompleted',
        authData: {
          token: platformAuth.token,
          user: platformAuth.user,
          isAuthenticated: true
        }
      });

      showAuthenticatedState();
    } else {
      console.log('No platform authentication found');
      authState.checking = false;
      showLoginState();
    }
  } catch (error) {
    console.error('Error checking authentication:', error);
    authState.checking = false;
    showErrorState('Error checking authentication: ' + error.message);
  }
}

// Busca autenticação armazenada
function getStoredAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['voidrAuth'], (result) => {
      resolve(result.voidrAuth || null);
    });
  });
}

// Armazena autenticação
function storeAuth(authData) {
  return new Promise((resolve) => {
    const dataToStore = {
      token: authData.token,
      user: authData.user,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 horas
      isAuthenticated: true
    };

    chrome.storage.local.set({ voidrAuth: dataToStore }, () => {
      console.log('Auth data stored successfully');
      resolve();
    });
  });
}

// Limpa autenticação armazenada
function clearStoredAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(['voidrAuth'], () => {
      console.log('Auth data cleared');
      resolve();
    });
  });
}

// Valida token usando os mesmos endpoints da aplicação
async function validateToken(token) {
  try {
    // Primeiro tenta o endpoint /auth/me (mesmo da aplicação)
    const authResponse = await fetch('http://localhost:3000/v1/auth/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (authResponse.ok) {
      const authData = await authResponse.json();

      // Tenta buscar o perfil também (mesmo fluxo da aplicação)
      try {
        const profileResponse = await fetch('http://localhost:3000/v1/profile/me', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (profileResponse.ok) {
          const profileData = await profileResponse.json();
          return {
            isValid: true,
            user: {
              ...authData.data,
              profile: profileData.data
            }
          };
        }
      } catch (profileError) {
        console.warn('Profile fetch failed, but auth is valid:', profileError);
      }

      return { isValid: true, user: authData.data };
    }

    return { isValid: false };
  } catch (error) {
    console.error('Token validation error:', error);
    return { isValid: false };
  }
}

// Verifica autenticação na plataforma
async function checkPlatformAuth() {
  try {
    console.log('Checking platform authentication...');

    // Primeiro, tenta buscar token do localStorage da plataforma
    const token = await getTokenFromPlatform();

    if (!token) {
      console.log('No token found in platform localStorage');
      return null;
    }

    console.log('Found token in platform, validating...');

    // Valida o token encontrado
    const validationResult = await validateToken(token);

    if (validationResult.isValid) {
      console.log('Platform token is valid');
      return {
        token: token,
        user: validationResult.user,
        isAuthenticated: true
      };
    } else {
      console.log('Platform token is invalid');
      return null;
    }
  } catch (error) {
    console.error('Platform auth check error:', error);
    return null;
  }
}

// Busca token do localStorage da plataforma (via content script)
async function getTokenFromPlatform() {
  return new Promise((resolve) => {
    // Injeta script na plataforma para buscar token
    chrome.tabs.query({ url: 'http://localhost:3030/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.scripting.executeScript(
          {
            target: { tabId: tabs[0].id },
            func: (cacheKey) => {
              // Busca token no localStorage da plataforma usando a chave correta
              try {
                const auth0Cache = localStorage.getItem(cacheKey);
                if (auth0Cache) {
                  const cacheData = JSON.parse(auth0Cache);
                  return cacheData.body?.access_token || null;
                }
                return null;
              } catch (e) {
                console.error('Error getting token from platform:', e);
                return null;
              }
            },
            args: [API_CONFIG.auth0.cacheKey]
          },
          (results) => {
            if (results && results[0] && results[0].result) {
              resolve(results[0].result);
            } else {
              resolve(null);
            }
          }
        );
      } else {
        resolve(null);
      }
    });
  });
}

// Atualiza status da conexão
function updateStatus(type, message) {
  if (elements.statusIndicator && elements.statusText) {
    elements.statusIndicator.className = `status-indicator ${type}`;
    elements.statusText.textContent = message;
  }
}

// Mostra estado específico
function showState(stateName) {
  // Esconde todos os estados
  Object.keys(elements).forEach((key) => {
    if (key.includes('State')) {
      elements[key]?.classList.add('hidden');
    }
  });

  // Mostra estado específico
  const stateElement = elements[`${stateName}State`];
  if (stateElement) {
    stateElement.classList.remove('hidden');
  }
}

// Mostra estado de login
function showLoginState() {
  updateStatus('disconnected', 'Not authenticated');
  showState('login');
}

// Mostra estado autenticado
function showAuthenticatedState() {
  updateStatus('connected', 'Connected');
  showState('authenticated');

  // Atualiza informações do usuário
  if (authState.user && elements.userName && elements.userEmail) {
    elements.userName.textContent =
      authState.user.profile?.fullName || authState.user.name || authState.user.email || 'User';
    elements.userEmail.textContent = authState.user.email || authState.user.profile?.email || '';

    // Atualiza avatar se houver foto
    if (authState.user.picture && elements.userAvatar) {
      elements.userAvatar.innerHTML = `<img src="${authState.user.picture}" alt="Avatar" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
    }
  }
}

// Mostra estado de erro
function showErrorState(message) {
  updateStatus('error', 'Connection error');
  showState('error');

  if (elements.errorMessage) {
    elements.errorMessage.textContent = message;
  }
}

// Abre plataforma Voidr com rota específica da extensão
function openPlatformVoidr() {
  // Primeiro fecha a aba de auth atual
  window.close();

  // Envia mensagem para o background script abrir a plataforma
  chrome.runtime.sendMessage({
    action: 'openPlatformForAuth'
  });
}

// Tenta autenticação novamente
function retryAuthentication() {
  authState.checking = true;
  checkAuthentication();
}

// Continua para extensão
function continueToExtension() {
  // Verifica se há URL de retorno armazenada
  const returnUrl = localStorage.getItem('extensionReturnUrl');

  if (returnUrl) {
    // Remove da storage e redireciona
    localStorage.removeItem('extensionReturnUrl');
    window.location.href = returnUrl;
  } else {
    // Fecha a aba se não há URL de retorno
    window.close();
  }

  // Notifica background script que auth foi concluída
  chrome.runtime.sendMessage({
    action: 'authCompleted',
    authData: {
      token: authState.token,
      user: authState.user,
      isAuthenticated: true
    }
  });
}

// Logout
async function logout() {
  try {
    // Limpa dados armazenados
    await clearStoredAuth();

    // Reset estado
    authState = {
      isAuthenticated: false,
      user: null,
      token: null,
      checking: false
    };

    // Mostra estado de login
    showLoginState();

    // Notifica background script
    chrome.runtime.sendMessage({
      action: 'authLogout'
    });
  } catch (error) {
    console.error('Logout error:', error);
    showErrorState('Error during logout: ' + error.message);
  }
}

// Tenta conexão novamente
function retryConnection() {
  authState.checking = true;
  checkAuthentication();
}

// Listener para mensagens do background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Auth page received message:', request);

  switch (request.action) {
    case 'checkAuth':
      checkAuthentication();
      break;

    case 'forceLogout':
      logout();
      break;

    case 'authenticationCompleted':
      console.log('Authentication completed, updating UI...');
      // Atualiza o estado e mostra sucesso
      authState = {
        isAuthenticated: true,
        user: request.user,
        token: null, // Será carregado na próxima verificação
        checking: false
      };
      showAuthenticatedState();
      break;
  }
});

// Verifica se a página foi aberta da extensão
window.addEventListener('load', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const returnTo = urlParams.get('returnTo');

  if (returnTo) {
    console.log('Extension auth opened with return URL:', returnTo);
    // Armazena a URL de retorno para usar depois
    localStorage.setItem('extensionReturnUrl', returnTo);
  }
});

// Verificação periódica de autenticação (a cada 5 minutos)
setInterval(() => {
  if (authState.isAuthenticated && authState.token) {
    validateToken(authState.token).then((result) => {
      if (!result.isValid) {
        console.log('Token expired, logging out...');
        logout();
      }
    });
  }
}, 5 * 60 * 1000);
