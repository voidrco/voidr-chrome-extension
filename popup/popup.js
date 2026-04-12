let currentView = 'main';
let onboardingRecordingContext = null;

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
        <p class="main-desc">Capture user sessions for onboarding test generation.</p>
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
  codeInput?.focus();
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
      payload: {
        action: 'voidr:startSessionRecording',
        testCaseName: onboardingRecordingContext.sessionName || 'Onboarding Session',
        mode: 'onboarding',
        slug: onboardingRecordingContext.appId,
        applicationId: onboardingRecordingContext.appId,
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
