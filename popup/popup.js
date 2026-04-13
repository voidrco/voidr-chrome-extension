let currentView = 'main';
let onboardingRecordingContext = null;
let testCaseRecordingContext = null;

function getApiBaseUrl() {
  const env = (typeof globalThis !== 'undefined' && globalThis.__VOIDR_ENV__) || {};
  return env.VOIDR_API_BASE_URL || 'https://voidr-service-785568282479.us-central1.run.app/v1';
}

async function apiGet(endpoint) {
  const auth = await getAuthStatus();
  if (!auth.isAuthenticated || !auth.token) {
    throw new Error('Not authenticated');
  }
  const url = `${getApiBaseUrl()}${endpoint}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

document.addEventListener('DOMContentLoaded', async () => {
  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action === 'voidr:sessionStarted') {
      showNotification('Recording started', 'success', 1800);
    } else if (request?.action === 'voidr:sessionCaptured' && request.sessionId) {
      if (currentView === 'onboarding-recording' && onboardingRecordingContext) {
        if (!request.onboardingRunId || request.onboardingRunId === onboardingRecordingContext.onboardingRunId) {
          showNotification('Session captured! You can close the customer tab.', 'success', 5000);
          onboardingRecordingContext = null;
          showMainView();
        }
      } else if (currentView === 'test-case-recording' && testCaseRecordingContext) {
        showSessionSummaryView(
          request.sessionId,
          testCaseRecordingContext.scenarioName,
          testCaseRecordingContext.appName,
        );
        testCaseRecordingContext = null;
      }
    } else if (request?.action === 'authStateUpdated' && request.authData?.isAuthenticated) {
      initializeExtension();
    }
  });

  await initializeExtension();
});

async function initializeExtension() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;

  try {
    const auth = await getAuthStatus();

    if (!auth.isAuthenticated) {
      showAuthRequired();
      return;
    }

    const stored = await chrome.storage.session.get('pendingOnboardingContext');
    if (stored?.pendingOnboardingContext) {
      onboardingRecordingContext = stored.pendingOnboardingContext;
      await chrome.storage.session.remove('pendingOnboardingContext');
      chrome.action.setBadgeText({ text: '' });
      showOnboardingRecordingView(onboardingRecordingContext);
      return;
    }

    showMainView();
  } catch (e) {
    console.error('[Voidr Popup] Init error:', e);
    contentDiv.innerHTML = `<div style="padding:40px 24px;text-align:center;color:rgba(255,255,255,.5);font-size:13px;">Erro ao inicializar. Feche e reabra a extensão.</div>`;
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function getAuthStatus() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ isAuthenticated: false }), 5000);
    try {
      chrome.runtime.sendMessage({ action: 'getAuthStatus' }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve({ isAuthenticated: false });
          return;
        }
        resolve(response || { isAuthenticated: false });
      });
    } catch (e) {
      clearTimeout(timeout);
      resolve({ isAuthenticated: false });
    }
  });
}

function showAuthRequired() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  currentView = 'auth';

  contentDiv.innerHTML = `
    <div class="auth-view">
      <div class="auth-icon-wrap">
        ${getIcon('Shield', 36)}
      </div>
      <h3 class="auth-title">Conexão necessária</h3>
      <p class="auth-desc">Faça login na plataforma Voidr para usar a extensão.</p>
      <button id="auth-connect-btn" class="btn-primary">
        ${getIcon('LogIn', 16)}
        Conectar com Voidr
      </button>
    </div>
  `;

  document.getElementById('auth-connect-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('auth-connect-btn');
    if (btn) { btn.classList.add('loading'); }

    chrome.runtime.sendMessage({ action: 'getAuthConnectUrl' }, (res) => {
      const url = res?.url;
      if (!url) return;
      const w = 500, h = 600;
      const left = Math.round((screen.width - w) / 2);
      const top = Math.round((screen.height - h) / 2);
      const authWin = window.open(url, 'voidr-auth', `width=${w},height=${h},left=${left},top=${top},popup=1`);

      const poll = setInterval(async () => {
        const auth = await getAuthStatus();
        if (auth.isAuthenticated) {
          clearInterval(poll);
          try { authWin?.close(); } catch (_) {}
          initializeExtension();
        }
      }, 2000);

      setTimeout(() => clearInterval(poll), 120000);
    });
  });
}

// ── Main View ────────────────────────────────────────────────────────────────

function showMainView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  currentView = 'main';

  contentDiv.innerHTML = `
    <div class="main-view">
      <div class="main-hero">
        <div class="main-icon-wrap">
          ${getIcon('Camera', 28)}
        </div>
        <h2 class="main-title">Session Capture</h2>
        <p class="main-desc">Grave sessões para gerar casos de teste ou onboarding.</p>
      </div>

      <button id="record-session-btn" class="btn-primary btn-block">
        ${getIcon('Video', 16)}
        Gravar Sessão
      </button>

      <div class="separator">
        <span class="separator-line"></span>
        <span class="separator-text">ou</span>
        <span class="separator-line"></span>
      </div>

      <div class="code-card">
        <div class="code-label">Onboarding Code</div>
        <div class="code-input-row">
          <input type="text" id="onboarding-code-input" class="code-input" placeholder="Ex: VDR-A7X3K2" />
          <button id="onboarding-code-btn" class="btn-primary btn-sm">Conectar</button>
        </div>
        <p class="code-hint">Cole o código exibido no assistente Voidr para iniciar a gravação.</p>
        <div id="onboarding-code-error" class="code-error"></div>
      </div>
    </div>
  `;

  document.getElementById('record-session-btn')?.addEventListener('click', () => {
    showSelectProductView();
  });

  const codeInput = document.getElementById('onboarding-code-input');
  const codeBtn = document.getElementById('onboarding-code-btn');
  const codeError = document.getElementById('onboarding-code-error');

  const submitCode = () => {
    const code = (codeInput?.value || '').trim().toUpperCase();
    if (!code) return;
    if (codeBtn) { codeBtn.textContent = '...'; codeBtn.disabled = true; }
    if (codeError) { codeError.style.display = 'none'; }

    chrome.runtime.sendMessage({ action: 'voidr:getOnboardingByCode', code }, (response) => {
      if (chrome.runtime.lastError || !response?.context) {
        if (codeBtn) { codeBtn.textContent = 'Conectar'; codeBtn.disabled = false; }
        if (codeError) {
          codeError.textContent = response?.error || 'Código não encontrado. Verifique e tente novamente.';
          codeError.style.display = 'block';
        }
        return;
      }
      onboardingRecordingContext = response.context;
      showOnboardingRecordingView(response.context);
    });
  };

  codeBtn?.addEventListener('click', submitCode);
  codeInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });
}

// ── Select Product View ──────────────────────────────────────────────────────

function showSelectProductView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  currentView = 'select-product';

  contentDiv.innerHTML = `
    <div class="select-product-view">
      <div class="view-header">
        <button id="back-to-main-btn" class="btn-back">
          ${getIcon('ChevronLeft', 18)}
        </button>
        <div>
          <h2 class="view-title">Selecionar Produto</h2>
          <p class="view-desc">Escolha o produto para gravar a sessão.</p>
        </div>
      </div>
      <div id="product-list-container" class="product-list-container">
        <div class="loading-state">
          ${getIcon('Loader', 20)}
          <span>Carregando produtos...</span>
        </div>
      </div>
    </div>
  `;

  document.getElementById('back-to-main-btn')?.addEventListener('click', () => showMainView());

  loadProducts();
}

async function loadProducts() {
  const container = document.getElementById('product-list-container');
  if (!container) return;

  container.innerHTML = `
    <div class="loading-state">
      ${getIcon('Loader', 20)}
      <span>Carregando produtos...</span>
    </div>
  `;

  try {
    const data = await apiGet('/applications?limit=50');
    const apps = Array.isArray(data.data) ? data.data : [];

    if (apps.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          ${getIcon('Layers', 20)}
          <span>Nenhum produto encontrado.</span>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="product-list">
        ${apps.map((app) => `
          <button class="product-item" data-app-id="${escapeHtml(app._id)}" data-app-name="${escapeHtml(app.name)}" data-app-type="${escapeHtml(app.type || '')}">
            <div class="product-item-info">
              <span class="product-item-name">${escapeHtml(app.name)}</span>
              ${app.type ? `<span class="product-item-type">${escapeHtml(app.type)}</span>` : ''}
            </div>
            ${getIcon('ChevronRight', 16)}
          </button>
        `).join('')}
      </div>
    `;

    container.querySelectorAll('.product-item').forEach((item) => {
      item.addEventListener('click', () => {
        const app = {
          _id: item.dataset.appId,
          name: item.dataset.appName,
          type: item.dataset.appType,
        };
        showRecordingSetupView(app);
      });
    });
  } catch (err) {
    console.error('[Voidr Popup] loadProducts error:', err);
    container.innerHTML = `
      <div class="empty-state">
        ${getIcon('AlertCircle', 20)}
        <span>${escapeHtml(err.message || 'Erro ao carregar produtos.')}</span>
        <button id="retry-products-btn" class="btn-ghost btn-sm" style="margin-top:8px;">Tentar novamente</button>
      </div>
    `;
    document.getElementById('retry-products-btn')?.addEventListener('click', loadProducts);
  }
}

// ── Recording Setup View ─────────────────────────────────────────────────────

function showRecordingSetupView(app) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  currentView = 'recording-setup';

  contentDiv.innerHTML = `
    <div class="setup-view">
      <div class="view-header">
        <button id="back-to-products-btn" class="btn-back">
          ${getIcon('ChevronLeft', 18)}
        </button>
        <div>
          <h2 class="view-title">Gravar Sessão</h2>
          <p class="view-desc">${escapeHtml(app.name)}</p>
        </div>
      </div>

      <div class="rec-card">
        <div class="rec-field">
          <span class="rec-field-label">Produto</span>
          <span class="rec-field-value">${escapeHtml(app.name)}</span>
        </div>

        <div class="rec-field">
          <span class="rec-field-label">Nome do cenário</span>
          <input type="text" id="scenario-name-input" class="setup-input" placeholder="Ex: Fluxo de checkout" />
        </div>

        <div id="setup-error" class="code-error"></div>

        <div class="rec-actions">
          <button id="start-recording-btn" class="btn-primary btn-flex">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="8,5 19,12 8,19"/></svg>
            Iniciar gravação
          </button>
          <button id="back-setup-btn" class="btn-ghost">Voltar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('back-to-products-btn')?.addEventListener('click', () => showSelectProductView());
  document.getElementById('back-setup-btn')?.addEventListener('click', () => showSelectProductView());
  document.getElementById('scenario-name-input')?.focus();

  document.getElementById('start-recording-btn')?.addEventListener('click', () => {
    handleStartTestCaseRecording(app);
  });

  document.getElementById('scenario-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleStartTestCaseRecording(app);
  });
}

async function handleStartTestCaseRecording(app) {
  const nameInput = document.getElementById('scenario-name-input');
  const scenarioName = (nameInput?.value || '').trim();
  const errorDiv = document.getElementById('setup-error');
  const btn = document.getElementById('start-recording-btn');

  if (!scenarioName) {
    if (errorDiv) {
      errorDiv.textContent = 'Informe o nome do cenário.';
      errorDiv.style.display = 'block';
    }
    nameInput?.focus();
    return;
  }

  if (errorDiv) { errorDiv.style.display = 'none'; }
  if (btn) { btn.textContent = 'Iniciando...'; btn.disabled = true; }

  let apiKey = null;
  try {
    const configData = await apiGet('/customer-configs');
    apiKey = configData?.data?.apiKey || configData?.apiKey || null;
  } catch (_) {}

  if (!apiKey) {
    if (errorDiv) {
      errorDiv.textContent = 'API Key não encontrada. Verifique as configurações do produto.';
      errorDiv.style.display = 'block';
    }
    if (btn) { btn.textContent = 'Iniciar gravação'; btn.disabled = false; }
    return;
  }

  testCaseRecordingContext = {
    appId: app._id,
    appName: app.name,
    scenarioName,
    apiKey,
  };

  currentView = 'test-case-recording';

  chrome.runtime.sendMessage(
    {
      action: 'voidr:forwardToTargetTab',
      payload: {
        action: 'voidr:startSessionRecording',
        testCaseName: scenarioName,
        mode: 'test-case',
        slug: app._id,
        applicationId: app._id,
        apiKey,
      },
    },
    (response) => {
      if (!response?.success) {
        const msg = response?.error || 'Abra a aba do site-alvo e tente novamente.';
        showNotification('Could not start: ' + msg, 'error', 4000);
        if (btn) { btn.textContent = 'Iniciar gravação'; btn.disabled = false; }
        currentView = 'recording-setup';
        testCaseRecordingContext = null;
        return;
      }
      window.close();
    },
  );
}

// ── Session Summary View ─────────────────────────────────────────────────────

function showSessionSummaryView(sessionId, scenarioName, appName) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  currentView = 'session-summary';

  const shortId = sessionId ? sessionId.slice(-12) : '—';

  contentDiv.innerHTML = `
    <div class="summary-view">
      <div class="summary-icon-wrap">
        ${getIcon('CheckCircle2', 36)}
      </div>
      <h2 class="summary-title">Sessão capturada</h2>
      <p class="summary-desc">A gravação foi concluída com sucesso.</p>

      <div class="summary-card">
        <div class="summary-field">
          <span class="rec-field-label">Cenário</span>
          <span class="rec-field-value">${escapeHtml(scenarioName || 'Sem nome')}</span>
        </div>
        <div class="summary-field">
          <span class="rec-field-label">Produto</span>
          <span class="summary-field-text">${escapeHtml(appName || '—')}</span>
        </div>
        <div class="summary-field">
          <span class="rec-field-label">Session ID</span>
          <span class="summary-field-mono">${escapeHtml(shortId)}</span>
        </div>
      </div>

      <button id="summary-done-btn" class="btn-primary btn-block">
        Concluir
      </button>
    </div>
  `;

  document.getElementById('summary-done-btn')?.addEventListener('click', () => showMainView());
}

// ── Onboarding Recording View ────────────────────────────────────────────────

function showOnboardingRecordingView(context) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  currentView = 'onboarding-recording';

  const flows = Array.isArray(context.criticalFlows || context.flows) ? (context.criticalFlows || context.flows) : [];

  contentDiv.innerHTML = `
    <div class="rec-view">
      <div class="rec-header">
        <div class="rec-dot-wrap">
          <span class="rec-dot"></span>
        </div>
        <h2 class="rec-title">Onboarding Recording</h2>
        <p class="rec-desc">Execute os fluxos abaixo e inicie a gravação.</p>
      </div>

      <div class="rec-card">
        <div class="rec-field">
          <span class="rec-field-label">Session</span>
          <span class="rec-field-value">${escapeHtml(context.sessionName || 'Onboarding Session')}</span>
        </div>

        ${context.targetUrl ? `
          <div class="rec-field">
            <span class="rec-field-label">Target</span>
            <span class="rec-field-url">${escapeHtml(context.targetUrl)}</span>
          </div>
        ` : ''}

        ${flows.length > 0 ? `
          <div class="rec-field">
            <span class="rec-field-label">Critical Flows</span>
            <div class="rec-flows">
              ${flows.map((f, i) => `
                <div class="rec-flow-item">
                  <span class="rec-flow-num">${i + 1}</span>
                  <span class="rec-flow-name">${escapeHtml(f.name || f.id || 'Flow ' + (i + 1))}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="rec-actions">
          <button id="onboarding-start-btn" class="btn-primary btn-flex">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="8,5 19,12 8,19"/></svg>
            Iniciar gravação
          </button>
          <button id="onboarding-cancel-btn" class="btn-ghost">Cancelar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('onboarding-start-btn')?.addEventListener('click', () => {
    handleStartOnboardingRecording();
  });
  document.getElementById('onboarding-cancel-btn')?.addEventListener('click', () => {
    onboardingRecordingContext = null;
    showMainView();
  });
}

async function handleStartOnboardingRecording() {
  if (!onboardingRecordingContext) return;
  const btn = document.getElementById('onboarding-start-btn');
  if (btn) { btn.textContent = 'Iniciando...'; btn.disabled = true; }

  if (onboardingRecordingContext.authToken) {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'validateAndStoreToken', token: onboardingRecordingContext.authToken },
          () => resolve(),
        );
      });
    } catch (_) {}
  }

  let targetHost = null;
  try {
    if (onboardingRecordingContext.targetUrl) {
      targetHost = new URL(onboardingRecordingContext.targetUrl).origin + '/*';
    }
  } catch (_) {}

  chrome.runtime.sendMessage(
    {
      action: 'voidr:forwardToTargetTab',
      targetHost,
      targetUrl: onboardingRecordingContext.targetUrl,
      payload: {
        action: 'voidr:startSessionRecording',
        testCaseName: onboardingRecordingContext.sessionName || 'Onboarding Session',
        mode: 'onboarding',
        slug: onboardingRecordingContext.applicationId || onboardingRecordingContext.appId,
        applicationId: onboardingRecordingContext.applicationId || onboardingRecordingContext.appId,
        apiKey: onboardingRecordingContext.apiKey,
        onboardingRunId: onboardingRecordingContext.onboardingRunId,
        flows: onboardingRecordingContext.criticalFlows || onboardingRecordingContext.flows || [],
      },
    },
    (response) => {
      if (!response?.success) {
        const msg = response?.error || 'Abra a aba do site-alvo e tente novamente.';
        showNotification('Could not start: ' + msg, 'error', 4000);
        if (btn) { btn.textContent = 'Iniciar gravação'; btn.disabled = false; }
        return;
      }
      window.close();
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showNotification(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.voidr-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = `voidr-notification voidr-notification--${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  requestAnimationFrame(() => notification.classList.add('visible'));

  setTimeout(() => {
    notification.classList.remove('visible');
    setTimeout(() => notification.remove(), 300);
  }, duration);
}
