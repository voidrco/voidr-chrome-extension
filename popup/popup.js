let currentView = 'main';
let recordingCodeContext = null;
let testCaseRecordingContext = null;
let activeLoopTimer = null;
let loopFinalizationMonitor = null;
let loopCreationState = { applications: [], environments: [] };
let sessionCreationState = { environments: [] };

const recordingUx = globalThis.VoidrRecordingUx;

function getApiBaseUrl() {
  const env = (typeof globalThis !== 'undefined' && globalThis.__VOIDR_ENV__) || {};
  return env.VOIDR_API_BASE_URL || 'https://api.voidr.co/v1';
}

async function apiRequest(endpoint, method = 'GET', data) {
  const auth = await getAuthStatus();
  if (!auth.isAuthenticated || !auth.token) {
    const error = new Error('Sua sessão expirou. Entre novamente na Voidr.');
    error.status = 401;
    throw error;
  }
  const url = `${getApiBaseUrl()}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    const error = new Error(
      payload?.message || payload?.error?.message || `A API respondeu com erro ${res.status}.`,
    );
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

const apiGet = (endpoint) => apiRequest(endpoint, 'GET');
const apiPost = (endpoint, data) => apiRequest(endpoint, 'POST', data);

document.addEventListener('DOMContentLoaded', async () => {
  const version = chrome.runtime.getManifest().version;
  const versionLabel = document.querySelector('.version');
  if (versionLabel) versionLabel.textContent = `Voidr Capture · v${version}`;
  const logoutIcon = document.querySelector('.header-logout-icon');
  if (logoutIcon) logoutIcon.innerHTML = getIcon('LogOut', 15);
  document.getElementById('auth-logout-btn')?.addEventListener('click', handleAuthLogout);

  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action === 'voidr:sessionStarted') {
      if (['loop-test', 'verification'].includes(request.mode) || currentView === 'active-loop') {
        initializeExtension();
      }
    } else if (request?.action === 'voidr:sessionCaptured' && request.sessionId) {
      if (currentView === 'code-recording' && recordingCodeContext) {
        const eventCode = request.code?.trim().toUpperCase();
        const currentCode = recordingCodeContext.code?.trim().toUpperCase();
        if (
          eventCode &&
          currentCode &&
          eventCode === currentCode &&
          request.confirmed === true &&
          (!request.onboardingRunId ||
            request.onboardingRunId === recordingCodeContext.onboardingRunId)
        ) {
          showNotification(
            'Gravação selada. A indexação continuará em segundo plano.',
            'success',
            5000,
          );
          recordingCodeContext = null;
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
    } else if (request?.action === 'voidr:loopFinalizationUpdated' && request.finalization) {
      if (currentView === 'loop-finalization') {
        showLoopFinalizationView(request.finalization);
      }
    }
  });

  await initializeExtension();
});

async function initializeExtension() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;

  try {
    const recorderState = await sendRuntimeMessage({ action: 'voidr:getRecordingState' });
    if (['loop-test', 'verification'].includes(recorderState?.active?.mode)) {
      showActiveLoopView(recorderState.active);
      return;
    }

    if (recorderState?.startupFailure) {
      showLoopStartupFailureView(recorderState.startupFailure);
      return;
    }

    if (recorderState?.finalization) {
      showLoopFinalizationView(recorderState.finalization);
      if (!['acknowledged', 'product_ready', 'failed'].includes(recorderState.finalization.state)) {
        void monitorLoopFinalization(recorderState.finalization);
      }
      return;
    }

    const auth = await getAuthStatus();

    if (!auth.isAuthenticated) {
      showAuthRequired();
      return;
    }

    const stored = await chrome.storage.session.get([
      'pendingRecordingCodeContext',
      'pendingOnboardingContext',
    ]);
    const pendingCodeContext =
      stored?.pendingRecordingCodeContext || stored?.pendingOnboardingContext;
    if (pendingCodeContext) {
      recordingCodeContext = pendingCodeContext;
      await chrome.storage.session.remove([
        'pendingRecordingCodeContext',
        'pendingOnboardingContext',
      ]);
      chrome.action.setBadgeText({ text: '' });
      showCodeRecordingView(recordingCodeContext);
      return;
    }

    // A test-case session was just captured while the popup was closed → show it.
    const cap = await chrome.storage.session.get(['voidrLastCapture', 'voidrPendingTestCase']);
    const last = cap?.voidrLastCapture;
    if (last?.sessionId && Date.now() - (last.capturedAt || 0) < 15 * 60 * 1000) {
      const pend = cap?.voidrPendingTestCase || {};
      await chrome.storage.session.remove(['voidrLastCapture', 'voidrPendingTestCase']);
      showSessionSummaryView(last.sessionId, pend.scenarioName, pend.appName, !!last.confirmed);
      return;
    }

    showMainView();
  } catch (e) {
    console.error('[Voidr Popup] Init error:', e);
    contentDiv.innerHTML =
      '<div class="init-error">Erro ao inicializar. Feche e reabra a extensão.</div>';
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

function setCurrentView(view) {
  currentView = view;
  const logoutButton = document.getElementById('auth-logout-btn');
  if (logoutButton) logoutButton.hidden = view !== 'main';
}

async function handleAuthLogout() {
  const logoutButton = document.getElementById('auth-logout-btn');
  if (logoutButton) logoutButton.disabled = true;
  const response = await sendRuntimeMessage({ action: 'authLogout' });
  if (logoutButton) logoutButton.disabled = false;
  if (!response?.success) {
    showNotification('Não foi possível sair. Tente novamente.', 'error', 4000);
    return;
  }
  showAuthRequired();
}

function showAuthRequired() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('auth');

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
    if (btn) {
      btn.classList.add('loading');
    }

    chrome.runtime.sendMessage({ action: 'getAuthConnectUrl' }, (res) => {
      const url = res?.url;
      if (!url) return;
      const w = 500,
        h = 600;
      const left = Math.round((screen.width - w) / 2);
      const top = Math.round((screen.height - h) / 2);
      const authWin = window.open(
        url,
        'voidr-auth',
        `width=${w},height=${h},left=${left},top=${top},popup=1`,
      );

      const poll = setInterval(async () => {
        const auth = await getAuthStatus();
        if (auth.isAuthenticated) {
          clearInterval(poll);
          try {
            authWin?.close();
          } catch (_) {}
          initializeExtension();
        }
      }, 2000);

      setTimeout(() => clearInterval(poll), 120000);
    });
  });
}

// ── Main View ────────────────────────────────────────────────────────────────

function showMainView() {
  loopFinalizationMonitor = null;
  if (activeLoopTimer) {
    clearInterval(activeLoopTimer);
    activeLoopTimer = null;
  }
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('main');

  contentDiv.innerHTML = `
    <div class="main-view">
      <div class="main-hero">
        <div class="main-icon-wrap">
          ${getIcon('Activity', 24, 1.5)}
        </div>
        <h2 class="main-title">O que deseja capturar?</h2>
        <p class="main-desc">Grave uma sessão livre ou reproduza um comportamento dentro de um Loop.</p>
      </div>

      <div class="capture-intents">
        <button id="record-session-btn" class="capture-intent">
          <span class="capture-intent-icon">${getIcon('Video', 17)}</span>
          <span class="capture-intent-copy">
            <strong>Gravar sessão</strong>
            <small>Cliques, navegação, requests, console e performance.</small>
          </span>
          ${getIcon('ChevronRight', 16)}
        </button>
        <button id="record-loop-btn" class="capture-intent">
          <span class="capture-intent-icon">${getIcon('Repeat2', 17)}</span>
          <span class="capture-intent-copy">
            <strong>Iniciar Loop</strong>
            <small>Reproduza o problema e anote no contexto.</small>
          </span>
          ${getIcon('ChevronRight', 16)}
        </button>
      </div>

      <div class="separator">
        <span class="separator-line"></span>
        <span class="separator-text">ou use o código do assistente</span>
        <span class="separator-line"></span>
      </div>

      <div class="code-card">
        <div class="code-label">Código de gravação</div>
        <div class="code-input-row">
          <input type="text" id="recording-code-input" class="code-input" placeholder="Ex: VDR-A7X3K2" />
          <button id="recording-code-btn" class="btn-primary btn-sm">Conectar</button>
        </div>
        <p class="code-hint">Cole o código exibido no assistente Voidr.</p>
        <div id="recording-code-error" class="code-error"></div>
      </div>

      <button id="open-loops-btn" class="btn-link">
        ${getIcon('ExternalLink', 14)}
        Ver Loops na Voidr
      </button>
    </div>
  `;

  document.getElementById('record-session-btn')?.addEventListener('click', showSelectProductView);
  document.getElementById('record-loop-btn')?.addEventListener('click', showLoopListView);

  const codeInput = document.getElementById('recording-code-input');
  const codeButton = document.getElementById('recording-code-btn');
  const codeError = document.getElementById('recording-code-error');
  const submitRecordingCode = () => {
    const code = (codeInput?.value || '').trim().toUpperCase();
    if (!code || codeButton?.disabled) return;
    codeButton.disabled = true;
    codeButton.textContent = '...';
    if (codeError) codeError.style.display = 'none';

    chrome.runtime.sendMessage({ action: 'voidr:getRecordingByCode', code }, (response) => {
      if (chrome.runtime.lastError || !response?.context) {
        codeButton.disabled = false;
        codeButton.textContent = 'Conectar';
        if (codeError) {
          codeError.textContent =
            response?.error || 'Código não encontrado. Verifique e tente novamente.';
          codeError.style.display = 'block';
        }
        return;
      }
      recordingCodeContext = { ...response.context, code };
      showCodeRecordingView(recordingCodeContext);
    });
  };

  codeButton?.addEventListener('click', submitRecordingCode);
  codeInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitRecordingCode();
  });

  document.getElementById('open-loops-btn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: `${API_CONFIG.platformUrl}/loops`, active: true }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  });
}

// ── Loop recording ───────────────────────────────────────────────────────────

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function showLoopListView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('loop-list');
  contentDiv.innerHTML = `
    <div class="select-product-view">
      <div class="view-header">
        <button id="back-from-loops-btn" class="btn-back" aria-label="Voltar">
          ${getIcon('ChevronLeft', 18)}
        </button>
        <div>
          <h2 class="view-title">Gravar Loop</h2>
          <p class="view-desc">Selecione um Loop elegível para gravar a referência.</p>
        </div>
        <button id="new-loop-btn" class="btn-secondary btn-sm view-header-action">
          ${getIcon('Plus', 14)}
          Novo
        </button>
      </div>
      <div id="loop-list-container" class="product-list-container">
        <div class="loading-state">
          ${getIcon('Loader', 20)}
          <span>Carregando Loops...</span>
        </div>
      </div>
    </div>
  `;
  document.getElementById('back-from-loops-btn')?.addEventListener('click', showMainView);
  document.getElementById('new-loop-btn')?.addEventListener('click', showCreateLoopView);
  loadLoopScenarios();
}

async function loadLoopScenarios() {
  const container = document.getElementById('loop-list-container');
  if (!container) return;
  try {
    const payload = await apiGet('/loop-test/scenarios');
    const scenarios = recordingUx.normalizeLoopScenarios(payload);
    const enriched = await Promise.all(
      scenarios.map(async (scenario) => {
        try {
          const detail = recordingUx.unwrapApiData(
            await apiGet(`/loop-test/scenarios/${encodeURIComponent(scenario.id)}`),
          );
          return {
            ...scenario,
            targetUrl: recordingUx.isSafeHttpUrl(detail?.targetUrl)
              ? detail.targetUrl
              : scenario.targetUrl,
            applicationName:
              detail?.applicationName ||
              detail?.application?.name ||
              detail?.applicationId ||
              scenario.applicationName,
          };
        } catch (_) {
          return scenario;
        }
      }),
    );

    if (!enriched.length) {
      container.innerHTML = `
        <div class="empty-state">
          ${getIcon('Repeat2', 22)}
          <span>Nenhum Loop disponível.</span>
          <small>Crie o primeiro Loop sem sair da extensão.</small>
          <button id="empty-new-loop-btn" class="btn-primary btn-sm">Novo Loop</button>
        </div>
      `;
      document.getElementById('empty-new-loop-btn')?.addEventListener('click', showCreateLoopView);
      return;
    }

    container.innerHTML = `<div class="loop-list">${enriched
      .map((scenario) => {
        const eligible = recordingUx.isLoopScenarioEligible(scenario);
        const target = scenario.targetUrl
          ? new URL(scenario.targetUrl).hostname
          : scenario.applicationName || 'Destino não informado';
        return `
          <button class="loop-item" data-scenario-id="${escapeHtml(scenario.id)}" ${
            eligible ? '' : 'disabled'
          }>
            <span class="loop-item-top">
              <span class="loop-item-name">${escapeHtml(scenario.name)}</span>
              <span class="loop-status loop-status--${escapeHtml(scenario.status)}">${escapeHtml(
                formatLoopStatus(scenario.status),
              )}</span>
            </span>
            <span class="loop-target">${getIcon('Globe2', 13)} ${escapeHtml(target)}</span>
            <span class="loop-meta">${
              eligible
                ? `Ciclo ${scenario.cycle} · pronto para gravar`
                : 'Aguarde o ciclo atual terminar'
            }</span>
          </button>
        `;
      })
      .join('')}</div><div id="loop-list-error" class="inline-error"></div>`;

    container.querySelectorAll('.loop-item:not(:disabled)').forEach((item) => {
      item.addEventListener('click', () => startLoopRecording(item.dataset.scenarioId, item));
    });
  } catch (error) {
    container.innerHTML = `
      <div class="empty-state">
        ${getIcon('AlertCircle', 22)}
        <span>${escapeHtml(loopErrorMessage(error))}</span>
        <button id="retry-loops-btn" class="btn-ghost btn-sm">Tentar novamente</button>
      </div>
    `;
    document.getElementById('retry-loops-btn')?.addEventListener('click', loadLoopScenarios);
  }
}

function showCreateLoopView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('create-loop');
  loopCreationState = { applications: [], environments: [] };
  contentDiv.innerHTML = `
    <div class="select-product-view loop-create-view">
      <div class="view-header">
        <button id="back-from-create-loop-btn" class="btn-back" aria-label="Voltar">
          ${getIcon('ChevronLeft', 18)}
        </button>
        <div>
          <h2 class="view-title">Novo Loop</h2>
          <p class="view-desc">Escolha o destino e descreva o problema.</p>
        </div>
      </div>

      <form id="create-loop-form" class="loop-create-form">
        <label class="loop-create-field">
          <span>Aplicação</span>
          <select id="loop-create-app" class="setup-input" disabled>
            <option value="">Carregando aplicações…</option>
          </select>
        </label>

        <fieldset id="loop-create-environments" class="loop-environment-fieldset" disabled>
          <legend>Onde deseja iniciar?</legend>
          <p>Confirme um ambiente cadastrado ou escolha criar outro.</p>
          <div id="loop-create-environment-options" class="loop-environment-options">
            <span class="loop-create-muted">Selecione uma aplicação primeiro.</span>
          </div>
        </fieldset>

        <div id="loop-create-new-environment" class="loop-create-new-environment" hidden>
          <label class="loop-create-field">
            <span>Nome do novo ambiente</span>
            <input id="loop-create-environment-name" class="setup-input" placeholder="Local, QA, staging…" />
          </label>
        </div>

        <label class="loop-create-field">
          <span>URL do teste</span>
          <input id="loop-create-target" class="setup-input loop-create-mono" placeholder="https://app.exemplo.com" disabled />
          <small>HTTP é aceito apenas em localhost ou domínios .local.</small>
        </label>

        <label class="loop-create-field">
          <span>O que precisa ser reproduzido?</span>
          <textarea id="loop-create-mission" class="setup-input loop-create-textarea" maxlength="300" placeholder="Ex.: o pagamento falha ao repetir depois de um timeout"></textarea>
        </label>

        <label class="loop-create-field">
          <span>Nome do Loop <em>opcional</em></span>
          <input id="loop-create-name" class="setup-input" maxlength="200" placeholder="Gerado a partir da missão" />
        </label>

        <div id="loop-create-error" class="inline-error" role="alert"></div>
        <button id="loop-create-submit" type="submit" class="btn-primary btn-block" disabled>
          ${getIcon('Plus', 15)}
          Criar e iniciar
        </button>
      </form>
    </div>
  `;

  document.getElementById('back-from-create-loop-btn')?.addEventListener('click', showLoopListView);
  document
    .getElementById('loop-create-app')
    ?.addEventListener('change', handleLoopApplicationChange);
  document.getElementById('create-loop-form')?.addEventListener('submit', submitNewLoop);
  void loadLoopCreationApplications();
}

async function loadLoopCreationApplications() {
  const select = document.getElementById('loop-create-app');
  const errorDiv = document.getElementById('loop-create-error');
  try {
    const payload = await apiGet('/applications?limit=100&sortBy=name&sortDir=asc');
    const applications = Array.isArray(payload?.data) ? payload.data : [];
    loopCreationState.applications = applications;
    if (!select) return;
    select.disabled = false;
    select.innerHTML = `
      <option value="">Selecione uma aplicação</option>
      ${applications
        .map(
          (app) =>
            `<option value="${escapeHtml(app._id || app.id)}">${escapeHtml(app.name || 'Aplicação')}</option>`,
        )
        .join('')}
    `;
    if (!applications.length && errorDiv) {
      errorDiv.textContent = 'Cadastre uma aplicação na Voidr antes de criar o Loop.';
    }
  } catch (error) {
    if (select) select.innerHTML = '<option value="">Aplicações indisponíveis</option>';
    if (errorDiv) errorDiv.textContent = loopErrorMessage(error);
  }
}

async function handleLoopApplicationChange(event) {
  const applicationId = event.target.value;
  const fieldset = document.getElementById('loop-create-environments');
  const options = document.getElementById('loop-create-environment-options');
  const target = document.getElementById('loop-create-target');
  const submit = document.getElementById('loop-create-submit');
  if (target) {
    target.value = '';
    target.disabled = true;
    target.readOnly = false;
  }
  if (submit) submit.disabled = true;
  document.getElementById('loop-create-new-environment')?.setAttribute('hidden', '');
  if (!applicationId) {
    if (fieldset) fieldset.disabled = true;
    if (options)
      options.innerHTML =
        '<span class="loop-create-muted">Selecione uma aplicação primeiro.</span>';
    return;
  }
  if (fieldset) fieldset.disabled = false;
  if (options) options.innerHTML = '<span class="loop-create-muted">Carregando ambientes…</span>';
  try {
    const payload = await apiGet(`/applications/${encodeURIComponent(applicationId)}/environments`);
    loopCreationState.environments = Array.isArray(payload?.data) ? payload.data : [];
    renderLoopEnvironmentChoices();
  } catch (error) {
    if (options)
      options.innerHTML = `<span class="inline-error">${escapeHtml(loopErrorMessage(error))}</span>`;
  }
}

function renderLoopEnvironmentChoices() {
  const options = document.getElementById('loop-create-environment-options');
  if (!options) return;
  options.innerHTML = `
    ${loopCreationState.environments
      .map(
        (environment) => `
          <label class="loop-environment-option">
            <input type="radio" name="loop-environment-choice" value="${escapeHtml(environment.slug)}" />
            <span>
              <strong>${escapeHtml(environment.name || environment.slug)}</strong>
              <small>${escapeHtml(environment.applicationUrl || '')}</small>
            </span>
          </label>
        `,
      )
      .join('')}
    <label class="loop-environment-option">
      <input type="radio" name="loop-environment-choice" value="__new__" />
      <span>
        <strong>Outro ambiente</strong>
        <small>Cadastrar um novo destino nesta aplicação</small>
      </span>
    </label>
  `;
  options.querySelectorAll('input[name="loop-environment-choice"]').forEach((input) => {
    input.addEventListener('change', handleLoopEnvironmentChoice);
  });
}

function handleLoopEnvironmentChoice(event) {
  const choice = event.target.value;
  const target = document.getElementById('loop-create-target');
  const newEnvironment = document.getElementById('loop-create-new-environment');
  const submit = document.getElementById('loop-create-submit');
  if (!target) return;
  target.disabled = false;
  if (choice === '__new__') {
    target.value = '';
    target.readOnly = false;
    newEnvironment?.removeAttribute('hidden');
  } else {
    const environment = loopCreationState.environments.find((item) => item.slug === choice);
    target.value = environment?.applicationUrl || '';
    target.readOnly = true;
    newEnvironment?.setAttribute('hidden', '');
  }
  if (submit) submit.disabled = false;
}

async function submitNewLoop(event) {
  event.preventDefault();
  const applicationId = document.getElementById('loop-create-app')?.value || '';
  const choice = document.querySelector('input[name="loop-environment-choice"]:checked')?.value;
  const targetUrl = document.getElementById('loop-create-target')?.value.trim() || '';
  const mission = document.getElementById('loop-create-mission')?.value.trim() || '';
  const name = document.getElementById('loop-create-name')?.value.trim() || '';
  const environmentName =
    document.getElementById('loop-create-environment-name')?.value.trim() || '';
  const errorDiv = document.getElementById('loop-create-error');
  const submit = document.getElementById('loop-create-submit');
  if (errorDiv) errorDiv.textContent = '';

  if (!applicationId || !choice) {
    if (errorDiv) errorDiv.textContent = 'Confirme a aplicação e o ambiente.';
    return;
  }
  if (choice === '__new__' && !environmentName) {
    if (errorDiv) errorDiv.textContent = 'Informe o nome do novo ambiente.';
    return;
  }
  if (!recordingUx.isAllowedLoopTarget(targetUrl)) {
    if (errorDiv) {
      errorDiv.textContent =
        'Use HTTPS. HTTP é permitido apenas para localhost ou domínios .local.';
    }
    return;
  }
  if (!mission) {
    if (errorDiv) errorDiv.textContent = 'Descreva o comportamento que deseja reproduzir.';
    return;
  }

  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Criando Loop…';
  }
  try {
    let environmentSlug = choice;
    if (choice === '__new__') {
      const createdEnvironment = recordingUx.unwrapApiData(
        await apiPost(`/applications/${encodeURIComponent(applicationId)}/environments`, {
          name: environmentName,
          applicationUrl: targetUrl,
        }),
      );
      environmentSlug = createdEnvironment?.slug;
    }
    if (!environmentSlug) throw new Error('A Voidr não retornou o ambiente criado.');
    const loop = recordingUx.unwrapApiData(
      await apiPost('/loop-test/scenarios', {
        ...(name ? { name } : {}),
        applicationId,
        environmentSlug,
        targetUrl,
        featureUnderTest: mission,
      }),
    );
    const scenarioId = loop?.id || loop?.scenarioId;
    if (!scenarioId) throw new Error('A Voidr não retornou o Loop criado.');
    const recording = recordingUx.unwrapApiData(
      await apiPost(`/loop-test/scenarios/${encodeURIComponent(scenarioId)}/recording-url`),
    );
    const recordingUrl = recording?.recordingUrl || recording?.url;
    if (!recordingUx.isSafeHttpUrl(recordingUrl)) {
      throw new Error('A Voidr retornou um endereço de gravação inválido.');
    }
    await chrome.tabs.create({ url: recordingUrl, active: true });
    window.close();
  } catch (error) {
    if (errorDiv) errorDiv.textContent = loopErrorMessage(error);
    if (submit) {
      submit.disabled = false;
      submit.textContent = 'Criar e iniciar';
    }
  }
}

function formatLoopStatus(status) {
  const labels = {
    recording: 'Gravação',
    ingesting: 'Processando',
    compiling: 'Compilando',
    replaying: 'Executando',
    comparing: 'Comparando',
    healing: 'Ajustando',
    green: 'Aprovado',
    failed: 'Falhou',
    fix_required: 'Correção necessária',
  };
  return labels[String(status || '').toLowerCase()] || String(status || 'Desconhecido');
}

function loopErrorMessage(error) {
  if (
    error?.status === 409 ||
    /baseline session|single recording|max(?:imum)? sessions?|limite de sess/i.test(
      error?.message || '',
    )
  ) {
    return 'Este Loop já atingiu o limite de sessões ou está sendo gravado.';
  }
  if (error?.status === 401 || error?.status === 403) {
    return 'Sua sessão expirou. Entre novamente na Voidr.';
  }
  if (error?.status === 402) {
    return 'Saldo de créditos insuficiente para iniciar este ciclo. Adicione créditos na Voidr e tente novamente.';
  }
  return error?.message || 'Não foi possível carregar os Loops.';
}

async function startLoopRecording(scenarioId, button) {
  const errorDiv = document.getElementById('loop-list-error');
  if (errorDiv) errorDiv.textContent = '';
  button.disabled = true;
  button.classList.add('loading');
  try {
    const payload = await apiPost(
      `/loop-test/scenarios/${encodeURIComponent(scenarioId)}/recording-url`,
    );
    const result = recordingUx.unwrapApiData(payload) || {};
    const recordingUrl = result.recordingUrl || result.url;
    if (!recordingUx.isSafeHttpUrl(recordingUrl)) {
      throw new Error('A Voidr retornou um endereço de gravação inválido.');
    }
    await chrome.tabs.create({ url: recordingUrl, active: true });
    window.close();
  } catch (error) {
    button.disabled = false;
    button.classList.remove('loading');
    if (errorDiv) errorDiv.textContent = loopErrorMessage(error);
  }
}

function showActiveLoopView(active) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  if (activeLoopTimer) clearInterval(activeLoopTimer);
  activeLoopTimer = null;
  setCurrentView('active-loop');
  const startedAt = active.startedAt || Date.now();
  const lifecycle = active.status || 'recording';
  const isStarting = lifecycle === 'starting';
  const isStopping = lifecycle === 'stopping';
  const eyebrow = isStarting
    ? 'Preparando gravação'
    : isStopping
      ? 'Finalizando gravação'
      : 'Gravando ciclo';
  const statusText = isStarting
    ? 'Preparando gravação'
    : isStopping
      ? 'Finalização em andamento'
      : 'Gravação ativa';
  contentDiv.innerHTML = `
    <div class="active-loop-view">
      <div class="active-loop-orbit"><span class="active-loop-dot"></span></div>
      <p class="eyebrow">${eyebrow}</p>
      <h2 class="active-loop-title">${escapeHtml(active.name || 'Ciclo em andamento')}</h2>
      <p class="active-loop-status"><span class="status-pulse"></span> ${statusText}</p>
      <div id="active-loop-elapsed" class="active-loop-elapsed">${isStarting ? '--:--' : '00:00'}</div>
      <section class="active-capture-summary" aria-label="Captura automática">
        <div class="active-capture-heading">
          ${getIcon('Activity', 14, 1.5)}
          <strong>Captura automática</strong>
        </div>
        <p>Cliques, páginas, requests, console e performance já estão sendo preservados.</p>
        <small>Use Anotar ou Voz na barra exibida sobre o site.</small>
      </section>
      <button id="finish-loop-btn" class="btn-primary btn-block" ${
        isStarting || isStopping ? 'disabled' : ''
      }>
        ${getIcon('Square', 14)}
        ${isStarting ? 'Aguarde…' : isStopping ? 'Finalizando…' : 'Finalizar gravação'}
      </button>
      <div id="active-loop-error" class="inline-error"></div>
    </div>
  `;

  const updateElapsed = () => {
    if (isStarting) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const value = [hours, minutes, seconds]
      .filter((_, index) => hours > 0 || index > 0)
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    const node = document.getElementById('active-loop-elapsed');
    if (node) node.textContent = value;
  };
  updateElapsed();
  if (!isStarting) activeLoopTimer = setInterval(updateElapsed, 1000);

  if (!isStarting && !isStopping) {
    document
      .getElementById('finish-loop-btn')
      ?.addEventListener('click', () => finishActiveLoop(active.generation));
  }
}

async function finishActiveLoop(lifecycleGeneration) {
  showLoopFinalizationView({
    state: 'stopping',
    generation: lifecycleGeneration,
    retryGeneration: lifecycleGeneration,
    updatedAt: Date.now(),
  });
  const result = await sendRuntimeMessage({
    action: 'voidr:sessionStopped',
    lifecycleGeneration,
  });
  if (!result?.success || !result?.finalized) {
    showLoopFinalizationView({
      state: 'failed',
      generation: lifecycleGeneration,
      retryGeneration: lifecycleGeneration,
      error: result?.error || 'Não foi possível finalizar. A gravação continua preservada.',
      updatedAt: Date.now(),
    });
    return;
  }
  if (activeLoopTimer) clearInterval(activeLoopTimer);
  activeLoopTimer = null;

  const verification = result.verification;
  if (!verification?.verificationId || !verification?.generation) {
    showLoopFinalizationView({
      state: 'product_ready',
      loopId: result.loopTest?.scenarioId,
      cycleId: result.loopTest?.cycleId,
      cycleNumber: result.loopTest?.cycleNumber,
      sessionId: result.sessionId,
      updatedAt: Date.now(),
    });
    await openLoopCodeHandoff(result.loopTest);
    return;
  }

  showLoopFinalizationView({
    ...verification,
    state: 'sealing',
    loopId: result.loopTest?.scenarioId,
    cycleId: result.loopTest?.cycleId,
    cycleNumber: result.loopTest?.cycleNumber,
    sessionId: result.sessionId,
    updatedAt: Date.now(),
  });
  const sealResult = await sendRuntimeMessage({
    action: 'voidr:verificationSeal',
    verificationId: verification.verificationId,
    generation: verification.generation,
    verification,
    stopResult: result,
  });
  if (!sealResult?.success) {
    const state = await sendRuntimeMessage({ action: 'voidr:getRecordingState' });
    if (state?.finalization) {
      showLoopFinalizationView(state.finalization);
      void monitorLoopFinalization(state.finalization);
      return;
    }
    showLoopFinalizationView({
      ...verification,
      state: 'failed',
      error:
        result.verificationError ||
        sealResult?.error ||
        'A gravação foi preservada, mas o contexto ainda não pôde ser publicado.',
      updatedAt: Date.now(),
    });
    return;
  }

  const finalization = sealResult.finalization || {
    ...verification,
    state: sealResult.pending
      ? 'pending'
      : globalThis.VoidrVerificationHandoffUx?.stateFromDelivery(
          sealResult.verification?.harnessDelivery,
        ) || 'product_ready',
    harness: sealResult.verification?.harness || null,
    harnessDelivery: sealResult.verification?.harnessDelivery || null,
    loopId: result.loopTest?.scenarioId,
    cycleId: result.loopTest?.cycleId,
    cycleNumber: result.loopTest?.cycleNumber,
    sessionId: result.sessionId,
    updatedAt: Date.now(),
  };
  showLoopFinalizationView(finalization);
  await openLoopCodeHandoff(result.loopTest);
  if (!['acknowledged', 'product_ready', 'failed'].includes(finalization.state)) {
    void monitorLoopFinalization(finalization);
  }
}

async function openLoopCodeHandoff(loopTest) {
  if (!loopTest?.scenarioId || !loopTest?.cycleId) return false;
  const response = await sendRuntimeMessage({
    action: 'voidr:openLoopHandoff',
    scenarioId: loopTest.scenarioId,
    cycleId: loopTest.cycleId,
    agent: 'codex',
  });
  return Boolean(response?.success);
}

function showLoopFinalizationView(finalization) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv || !globalThis.VoidrVerificationHandoffUx) return;
  setCurrentView('loop-finalization');
  const state = finalization.state || 'stopping';
  const view = globalThis.VoidrVerificationHandoffUx.viewModel(state, finalization.harness, {
    cycleNumber: finalization.cycleNumber,
    error: finalization.error,
  });
  const canOpen = Boolean(finalization.loopId && finalization.cycleId);
  const canRetryStop = Boolean(finalization.retryGeneration);
  const isWorking = !view.terminal || ['pending', 'available'].includes(state);
  const completedSteps = view.steps.filter((step) => step.state === 'done').length;
  const progressAttributes = view.terminal
    ? ''
    : ` aria-valuemin="0" aria-valuemax="${view.steps.length}" aria-valuenow="${completedSteps}" aria-label="Progresso da finalização"`;
  contentDiv.innerHTML = `
    <div class="loop-finalization-view is-${escapeHtml(view.tone)}" role="${
      view.terminal ? 'status' : 'progressbar'
    }"${progressAttributes} aria-live="polite">
      <div class="loop-finalization-brand" aria-hidden="true">
        <img src="../assets/logo-light.svg" alt="" />
        <span class="loop-finalization-orbit ${isWorking ? 'is-active' : ''}"><i></i></span>
      </div>
      <p class="loop-finalization-kicker">${escapeHtml(view.eyebrow)}</p>
      <h2 class="loop-finalization-title">${escapeHtml(view.title)}</h2>
      <p class="loop-finalization-detail">${escapeHtml(view.detail)}</p>
      <div class="loop-finalization-steps" aria-label="Progresso da finalização">
        ${view.steps
          .map(
            (step) => `
              <div class="loop-finalization-step is-${step.state}">
                <span class="loop-finalization-step-mark" aria-hidden="true">${
                  step.state === 'done'
                    ? getIcon('CheckCircle2', 13, 2)
                    : step.state === 'active'
                      ? getIcon('Loader', 13)
                      : ''
                }</span>
                <span>${escapeHtml(step.label)}</span>
              </div>`,
          )
          .join('')}
      </div>
      ${
        finalization.harness?.displayName || finalization.harness?.name
          ? `<div class="loop-finalization-receipt">
              ${getIcon('Activity', 14, 1.5)}
              <span>${escapeHtml(
                state === 'acknowledged' ? 'Recebido por' : 'Destino',
              )} <strong>${escapeHtml(
                finalization.harness.displayName || finalization.harness.name,
              )}</strong></span>
            </div>`
          : ''
      }
      <div class="loop-finalization-actions">
        ${
          canRetryStop
            ? '<button id="retry-loop-finalization" class="btn-primary btn-block">Tentar novamente</button>'
            : ''
        }
        ${
          canOpen
            ? `<button id="open-finalized-loop" class="btn-primary btn-block">${getIcon(
              'ExternalLink',
              14,
              )} Consolidar e resolver</button>`
            : ''
        }
        ${
          view.terminal
            ? '<button id="dismiss-loop-finalization" class="btn-ghost btn-block">Fechar</button>'
            : ''
        }
      </div>
      <p class="loop-finalization-footnote">Pode fechar esta janela. A Voidr continuará em segundo plano e preparará o VAP para o agente escolhido.</p>
    </div>
  `;

  document.getElementById('retry-loop-finalization')?.addEventListener('click', () => {
    void finishActiveLoop(finalization.retryGeneration);
  });
  document.getElementById('open-finalized-loop')?.addEventListener('click', async () => {
    await sendRuntimeMessage({
      action: 'voidr:openLoopHandoff',
      scenarioId: finalization.loopId,
      cycleId: finalization.cycleId,
      agent: 'codex',
    });
    window.close();
  });
  document.getElementById('dismiss-loop-finalization')?.addEventListener('click', async () => {
    await sendRuntimeMessage({ action: 'voidr:dismissLoopFinalization' });
    showMainView();
  });
}

async function monitorLoopFinalization(finalization) {
  if (!finalization?.verificationId || !finalization?.generation) return;
  const monitor = {};
  loopFinalizationMonitor = monitor;
  const deadline = Date.now() + 45_000;
  while (loopFinalizationMonitor === monitor && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const response = await sendRuntimeMessage({
      action: 'voidr:verificationHandoffStatus',
      verificationId: finalization.verificationId,
      generation: finalization.generation,
      loopId: finalization.loopId,
      cycleId: finalization.cycleId,
      cycleNumber: finalization.cycleNumber,
    });
    if (!response?.success || !response.finalization) continue;
    finalization = response.finalization;
    showLoopFinalizationView(finalization);
    if (['acknowledged', 'product_ready', 'failed'].includes(finalization.state)) break;
  }
  if (loopFinalizationMonitor === monitor) loopFinalizationMonitor = null;
}

function showLoopStartupFailureView(failure) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('loop-startup-failure');
  contentDiv.innerHTML = `
    <div class="summary-view">
      <div class="summary-icon-wrap summary-icon-wrap--error">${getIcon('AlertCircle', 36)}</div>
      <h2 class="summary-title">Loop não iniciado</h2>
      <p class="summary-desc">${escapeHtml(
        failure.reason || 'Não foi possível iniciar a gravação do Loop.',
      )}</p>
      <button id="dismiss-loop-failure-btn" class="btn-primary btn-block">Voltar ao início</button>
    </div>
  `;
  document.getElementById('dismiss-loop-failure-btn')?.addEventListener('click', async () => {
    await sendRuntimeMessage({ action: 'voidr:clearLoopStartupFailure' });
    showMainView();
  });
}

// ── Select Product View ──────────────────────────────────────────────────────

function showSelectProductView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('select-product');

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
        ${apps
          .map(
            (app) => `
          <button class="product-item" data-app-id="${escapeHtml(app._id)}" data-app-name="${escapeHtml(app.name)}" data-app-type="${escapeHtml(app.type || '')}">
            <div class="product-item-info">
              <span class="product-item-name">${escapeHtml(app.name)}</span>
              ${app.type ? `<span class="product-item-type">${escapeHtml(app.type)}</span>` : ''}
            </div>
            ${getIcon('ChevronRight', 16)}
          </button>
        `,
          )
          .join('')}
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
  setCurrentView('recording-setup');
  sessionCreationState = { environments: [] };

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

        <fieldset id="session-environments" class="loop-environment-fieldset" disabled>
          <legend>Onde deseja gravar?</legend>
          <p>Confirme um ambiente cadastrado ou escolha criar outro.</p>
          <div id="session-environment-options" class="loop-environment-options">
            <span class="loop-create-muted">Carregando ambientes…</span>
          </div>
        </fieldset>

        <div id="session-new-environment" class="loop-create-new-environment" hidden>
          <label class="loop-create-field">
            <span>Nome do novo ambiente</span>
            <input id="session-environment-name" class="setup-input" placeholder="Local, QA, staging…" />
          </label>
        </div>

        <label class="loop-create-field">
          <span>URL da sessão</span>
          <input id="session-target-url" class="setup-input loop-create-mono" placeholder="https://app.exemplo.com" disabled />
          <small>HTTP é aceito apenas em localhost ou domínios .local.</small>
        </label>

        <div class="rec-field">
          <span class="rec-field-label">Nome do cenário</span>
          <input type="text" id="scenario-name-input" class="setup-input" placeholder="Ex: Fluxo de checkout" />
        </div>

        <div id="setup-error" class="code-error"></div>

        <p class="recording-disclosure">
          Ao continuar, a Voidr captura interações, conteúdo visível, URLs e cookies necessários
          para reproduzir esta sessão e envia esses dados com segurança à sua organização.
          <a href="https://www.voidr.co/pt-br/legal/politica-privacidade" target="_blank" rel="noopener noreferrer">Política de Privacidade</a>
        </p>

        <div class="rec-actions">
          <button id="start-recording-btn" class="btn-primary btn-flex" disabled>
            ${getIcon('Play', 14)}
            Concordo e iniciar
          </button>
          <button id="back-setup-btn" class="btn-ghost">Voltar</button>
        </div>
      </div>
    </div>
  `;

  document
    .getElementById('back-to-products-btn')
    ?.addEventListener('click', () => showSelectProductView());
  document
    .getElementById('back-setup-btn')
    ?.addEventListener('click', () => showSelectProductView());
  document.getElementById('scenario-name-input')?.focus();

  document.getElementById('start-recording-btn')?.addEventListener('click', () => {
    handleStartTestCaseRecording(app);
  });

  document.getElementById('scenario-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleStartTestCaseRecording(app);
  });
  void loadSessionEnvironments(app);
}

async function loadSessionEnvironments(app) {
  const fieldset = document.getElementById('session-environments');
  const options = document.getElementById('session-environment-options');
  const errorDiv = document.getElementById('setup-error');
  try {
    const payload = await apiGet(`/applications/${encodeURIComponent(app._id)}/environments`);
    sessionCreationState.environments = Array.isArray(payload?.data) ? payload.data : [];
    if (fieldset) fieldset.disabled = false;
    if (!options) return;
    options.innerHTML = `
      ${sessionCreationState.environments
        .map(
          (environment) => `
            <label class="loop-environment-option">
              <input type="radio" name="session-environment-choice" value="${escapeHtml(environment.slug)}" />
              <span>
                <strong>${escapeHtml(environment.name || environment.slug)}</strong>
                <small>${escapeHtml(environment.applicationUrl || '')}</small>
              </span>
            </label>`,
        )
        .join('')}
      <label class="loop-environment-option">
        <input type="radio" name="session-environment-choice" value="__new__" />
        <span>
          <strong>Outro ambiente</strong>
          <small>Cadastrar um novo destino nesta aplicação</small>
        </span>
      </label>`;
    options.querySelectorAll('input[name="session-environment-choice"]').forEach((input) => {
      input.addEventListener('change', handleSessionEnvironmentChoice);
    });
  } catch (error) {
    if (options)
      options.innerHTML = '<span class="loop-create-muted">Ambientes indisponíveis.</span>';
    if (errorDiv) {
      errorDiv.textContent = loopErrorMessage(error);
      errorDiv.style.display = 'block';
    }
  }
}

function handleSessionEnvironmentChoice(event) {
  const choice = event.target.value;
  const target = document.getElementById('session-target-url');
  const newEnvironment = document.getElementById('session-new-environment');
  const submit = document.getElementById('start-recording-btn');
  if (!target) return;
  target.disabled = false;
  if (choice === '__new__') {
    target.value = '';
    target.readOnly = false;
    newEnvironment?.removeAttribute('hidden');
  } else {
    const environment = sessionCreationState.environments.find((item) => item.slug === choice);
    target.value = environment?.applicationUrl || '';
    target.readOnly = true;
    newEnvironment?.setAttribute('hidden', '');
  }
  if (submit) submit.disabled = false;
}

// Pede a permissao de host da aba alvo no clique do usuario. Precisa rodar antes
// de qualquer await: o gesto expira e o Chrome recusa o prompt depois disso.
function ensureHostPermission(originPattern) {
  // Pede o padrao amplo, nao so o dominio cadastrado do app.
  //
  // Apps atras de autenticacao (Blip via Microsoft B2C, por exemplo) redirecionam:
  // a aba termina num dominio de login, nao no que esta cadastrado. Pedindo so o
  // cadastrado, tabs.query nao acha a aba e executeScript devolve "Cannot access
  // contents of the page" — foi o que quebrou a 1.0.0 em uso real.
  //
  // Nao da para ser mais preciso: sem permissao o Chrome esconde a URL da aba,
  // entao nao ha como descobrir o dominio final para pedir so ele.
  //
  // O ganho de politica que sobra e o que importa para a analise: nada e
  // concedido na instalacao, e a concessao acontece depois do aviso de captura.
  const origins = originPattern
    ? [originPattern, 'http://*/*', 'https://*/*']
    : ['http://*/*', 'https://*/*'];
  // Sem await antes daqui: qualquer um consome o gesto do usuario e o Chrome
  // recusa o prompt. request() ja resolve true na hora se a permissao existe.
  return chrome.permissions.request({ origins }).catch(() => false);
}

function hostOf(url) {
  try {
    return new URL(url).origin + '/*';
  } catch (_) {
    return null;
  }
}

async function handleStartTestCaseRecording(app) {
  if (!(await ensureHostPermission(hostOf(app.url)))) {
    showNotification('Permissao negada para o site alvo — a gravacao nao pode comecar.', 'error', 5000);
    return;
  }
  const nameInput = document.getElementById('scenario-name-input');
  const scenarioName = (nameInput?.value || '').trim();
  const errorDiv = document.getElementById('setup-error');
  const btn = document.getElementById('start-recording-btn');
  const environmentChoice = document.querySelector(
    'input[name="session-environment-choice"]:checked',
  )?.value;
  const targetUrl = document.getElementById('session-target-url')?.value.trim() || '';
  const environmentName = document.getElementById('session-environment-name')?.value.trim() || '';

  if (!scenarioName) {
    if (errorDiv) {
      errorDiv.textContent = 'Informe o nome do cenário.';
      errorDiv.style.display = 'block';
    }
    nameInput?.focus();
    return;
  }
  if (!environmentChoice) {
    if (errorDiv) {
      errorDiv.textContent = 'Confirme o ambiente onde deseja gravar.';
      errorDiv.style.display = 'block';
    }
    return;
  }
  if (environmentChoice === '__new__' && !environmentName) {
    if (errorDiv) {
      errorDiv.textContent = 'Informe o nome do novo ambiente.';
      errorDiv.style.display = 'block';
    }
    return;
  }
  if (!recordingUx.isAllowedLoopTarget(targetUrl)) {
    if (errorDiv) {
      errorDiv.textContent =
        'Use HTTPS. HTTP é permitido apenas para localhost ou domínios .local.';
      errorDiv.style.display = 'block';
    }
    return;
  }

  if (errorDiv) {
    errorDiv.style.display = 'none';
  }
  if (btn) {
    btn.textContent = 'Iniciando...';
    btn.disabled = true;
  }

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
    if (btn) {
      btn.textContent = 'Concordo e iniciar';
      btn.disabled = false;
    }
    return;
  }

  let environmentSlug = environmentChoice;
  if (environmentChoice === '__new__') {
    try {
      const createdEnvironment = recordingUx.unwrapApiData(
        await apiPost(`/applications/${encodeURIComponent(app._id)}/environments`, {
          name: environmentName,
          applicationUrl: targetUrl,
        }),
      );
      environmentSlug = createdEnvironment?.slug;
    } catch (error) {
      if (errorDiv) {
        errorDiv.textContent = loopErrorMessage(error);
        errorDiv.style.display = 'block';
      }
      if (btn) {
        btn.textContent = 'Iniciar gravação';
        btn.disabled = false;
      }
      return;
    }
  }
  if (!environmentSlug) {
    if (errorDiv) {
      errorDiv.textContent = 'A Voidr não retornou o ambiente selecionado.';
      errorDiv.style.display = 'block';
    }
    if (btn) {
      btn.textContent = 'Iniciar gravação';
      btn.disabled = false;
    }
    return;
  }

  testCaseRecordingContext = {
    appId: app._id,
    appName: app.name,
    scenarioName,
    apiKey,
    environmentSlug,
    targetUrl,
  };

  setCurrentView('test-case-recording');

  chrome.runtime.sendMessage(
    {
      action: 'voidr:forwardToTargetTab',
      targetHost: `${new URL(targetUrl).origin}/*`,
      targetUrl,
      payload: {
        action: 'voidr:startSessionRecording',
        testCaseName: scenarioName,
        mode: 'test-case',
        slug: app._id,
        applicationId: app._id,
        apiKey,
        environmentSlug,
      },
    },
    (response) => {
      if (!response?.success) {
        const msg = response?.error || 'Abra a aba do site-alvo e tente novamente.';
        showNotification('Não foi possível iniciar: ' + msg, 'error', 4000);
        if (btn) {
          btn.textContent = 'Concordo e iniciar';
          btn.disabled = false;
        }
        setCurrentView('recording-setup');
        testCaseRecordingContext = null;
        return;
      }
      window.close();
    },
  );
}

// ── Session Summary View ─────────────────────────────────────────────────────

function showSessionSummaryView(sessionId, scenarioName, appName, preConfirmed = false) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('session-summary');

  const shortId = sessionId ? sessionId.slice(-12) : '—';

  const card = `
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
  `;

  const actions = `
      <div class="rec-actions">
        <button id="summary-home-btn" class="btn-primary btn-flex">Voltar ao início</button>
        <button id="summary-close-btn" class="btn-ghost">Fechar</button>
      </div>`;

  const bindActions = () => {
    document.getElementById('summary-home-btn')?.addEventListener('click', () => showMainView());
    document.getElementById('summary-close-btn')?.addEventListener('click', () => window.close());
  };

  // Estado 1: verificando no servidor (não afirma sucesso ainda).
  contentDiv.innerHTML = `
    <div class="summary-view">
      <div class="summary-icon-wrap summary-icon-wrap--pending loading-state">${getIcon('Loader', 36)}</div>
      <h2 class="summary-title">Verificando gravação…</h2>
      <p class="summary-desc">Confirmando que a sessão foi salva no servidor.</p>
      ${card}
    </div>
  `;

  const renderSuccess = () => {
    contentDiv.innerHTML = `
      <div class="summary-view">
        <div class="summary-icon-wrap">${getIcon('CheckCircle2', 36)}</div>
        <h2 class="summary-title">Sessão capturada</h2>
        <p class="summary-desc">A gravação foi salva no servidor com sucesso.</p>
        ${card}
        ${actions}
      </div>
    `;
    bindActions();
  };

  const renderFailure = () => {
    contentDiv.innerHTML = `
      <div class="summary-view">
        <div class="summary-icon-wrap summary-icon-wrap--error">${getIcon('AlertCircle', 36)}</div>
        <h2 class="summary-title">Gravação não confirmada</h2>
        <p class="summary-desc">A sessão foi finalizada, mas não foi encontrada no servidor. Os dados podem não ter sido salvos — tente gravar novamente.</p>
        ${card}
        ${actions}
      </div>
    `;
    bindActions();
  };

  if (!sessionId) {
    renderFailure();
    return;
  }

  // Already confirmed upstream (code-linked capture via an org-agnostic
  // endpoint). The org-scoped lookup below cannot see cross-org recording
  // sessions, so trust the upstream confirmation.
  if (preConfirmed) {
    renderSuccess();
    return;
  }

  const validateOnce = () =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: 'voidr:validateSession', sessionId }, (res) => {
          void chrome.runtime.lastError;
          resolve(!!res?.found);
        });
      } catch (_) {
        resolve(false);
      }
    });

  // A indexação no servidor pode atrasar 1-2s após o stop; tenta algumas vezes.
  (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await validateOnce()) {
        renderSuccess();
        return;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    renderFailure();
  })();
}

// ── Recording-code View ──────────────────────────────────────────────────────

function showCodeRecordingView(context) {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  setCurrentView('code-recording');

  const flows = Array.isArray(context.criticalFlows || context.flows)
    ? context.criticalFlows || context.flows
    : [];

  contentDiv.innerHTML = `
    <div class="rec-view">
      <div class="rec-header">
        <div class="rec-dot-wrap">
          <span class="rec-dot"></span>
        </div>
        <h2 class="rec-title">Gravação por código</h2>
        <p class="rec-desc">Revise o contexto e inicie a gravação.</p>
      </div>

      <div class="rec-card">
        <div class="rec-field">
          <span class="rec-field-label">Sessão</span>
          <span class="rec-field-value">${escapeHtml(context.sessionName || 'Sessão por código')}</span>
        </div>

        ${
          context.targetUrl
            ? `
          <div class="rec-field">
            <span class="rec-field-label">Destino</span>
            <span class="rec-field-url">${escapeHtml(context.targetUrl)}</span>
          </div>
        `
            : ''
        }

        ${
          flows.length > 0
            ? `
          <div class="rec-field">
            <span class="rec-field-label">Fluxos</span>
            <div class="rec-flows">
              ${flows
                .map(
                  (f, i) => `
                <div class="rec-flow-item">
                  <span class="rec-flow-num">${i + 1}</span>
                  <span class="rec-flow-name">${escapeHtml(f.name || f.id || 'Flow ' + (i + 1))}</span>
                </div>
              `,
                )
                .join('')}
            </div>
          </div>
        `
            : ''
        }

        <p class="recording-disclosure">
          Ao continuar, a Voidr captura interações, conteúdo visível, URLs e cookies necessários
          para reproduzir esta sessão e envia esses dados com segurança à sua organização.
          <a href="https://www.voidr.co/pt-br/legal/politica-privacidade" target="_blank" rel="noopener noreferrer">Política de Privacidade</a>
        </p>

        <div class="rec-actions">
          <button id="code-recording-start-btn" class="btn-primary btn-flex">
            ${getIcon('Play', 14)}
            Concordo e iniciar
          </button>
          <button id="code-recording-cancel-btn" class="btn-ghost">Cancelar</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('code-recording-start-btn')?.addEventListener('click', () => {
    handleStartCodeRecording();
  });
  document.getElementById('code-recording-cancel-btn')?.addEventListener('click', () => {
    recordingCodeContext = null;
    showMainView();
  });
}

async function handleStartCodeRecording() {
  if (!recordingCodeContext) {
    showNotification('Sem contexto de gravação — recarregue e pareie o código novamente.', 'error', 6000);
    return;
  }
  const alvo = hostOf(recordingCodeContext.targetUrl);
  const concedida = await ensureHostPermission(alvo);
  if (!concedida) {
    showNotification(
      `Permissao negada para ${alvo || 'o site alvo'} — sem ela a Voidr nao consegue gravar. Clique novamente e escolha Permitir.`,
      'error',
      8000,
    );
    return;
  }
  // request() pode resolver true sem o dominio pedido em casos de borda; conferir
  // antes de seguir evita o erro opaco do background.
  if (!(await chrome.permissions.contains({ origins: ['https://*/*'] }).catch(() => true))) {
    showNotification(
      'A Voidr precisa de acesso ao site para gravar. Clique novamente e escolha Permitir.',
      'error',
      8000,
    );
    return;
  }
  const btn = document.getElementById('code-recording-start-btn');
  if (btn) {
    btn.textContent = 'Iniciando...';
    btn.disabled = true;
  }

  if (recordingCodeContext.authToken) {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'validateAndStoreToken', token: recordingCodeContext.authToken },
          () => resolve(),
        );
      });
    } catch (_) {}
  }

  let targetHost = null;
  try {
    if (recordingCodeContext.targetUrl) {
      targetHost = new URL(recordingCodeContext.targetUrl).origin + '/*';
    }
  } catch (_) {}

  // O resumo pos-gravacao le voidrPendingTestCase do storage. So o fluxo de
  // O fluxo por código também precisa persistir um resumo legível pós-gravação.
  const ctx = recordingCodeContext;
  const primeiroFluxo = (ctx.criticalFlows || ctx.flows || [])[0];
  let hostAlvo = '';
  try { hostAlvo = ctx.targetUrl ? new URL(ctx.targetUrl).host : ''; } catch (_) {}
  try {
    await chrome.storage.session.set({
      voidrPendingTestCase: {
        scenarioName:
          ctx.sessionName || primeiroFluxo?.name || ctx.name || 'Sessão por código',
        appName:
          ctx.applicationName || ctx.appName || ctx.application?.name || hostAlvo || '—',
        appId: ctx.applicationId || ctx.appId,
      },
    });
  } catch (_) {}

  chrome.runtime.sendMessage(
    {
      action: 'voidr:forwardToTargetTab',
      targetHost,
      targetUrl: recordingCodeContext.targetUrl,
      payload: {
        action: 'voidr:startSessionRecording',
        testCaseName: recordingCodeContext.sessionName || 'Sessão por código',
        // Compatibility mode/fields are consumed by the legacy platform protocol.
        mode: 'onboarding',
        slug: recordingCodeContext.applicationId || recordingCodeContext.appId,
        applicationId: recordingCodeContext.applicationId || recordingCodeContext.appId,
        environmentSlug: recordingCodeContext.environmentSlug,
        apiKey: recordingCodeContext.apiKey,
        onboardingRunId: recordingCodeContext.onboardingRunId,
        code: recordingCodeContext.code,
        flows: recordingCodeContext.criticalFlows || recordingCodeContext.flows || [],
      },
    },
    (response) => {
      if (!response?.success) {
        const msg =
          response?.error || chrome.runtime.lastError?.message || 'sem resposta do background';
        showNotification('Nao iniciou: ' + msg, 'error', 8000);
        if (btn) {
          btn.textContent = 'Concordo e iniciar';
          btn.disabled = false;
        }
        return;
      }
      window.close();
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
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
