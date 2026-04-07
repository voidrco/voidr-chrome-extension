// Content script to inject the Voidr widget into pages

console.log('Voidr Testing Assistant - Content script carregado');

// Estado global do widget
let voidrWidget = null;
let isWidgetVisible = false;
let voidrSettings = {};
let testPlanningContext = null;
let defectsContext = { items: [], loading: false, page: 1, limit: 20, hasMore: false, filters: {} };
let lastCapturedSessionId = null;
let newDefectDraft = { attachments: [], sessionId: null };

// Load services into page context
const tpScript = document.createElement('script');
tpScript.src = chrome.runtime.getURL('services/testPlanningService.js');
document.head.appendChild(tpScript);
const dfScript = document.createElement('script');
dfScript.src = chrome.runtime.getURL('services/defectsService.js');
document.head.appendChild(dfScript);
const storageScript = document.createElement('script');
storageScript.src = chrome.runtime.getURL('services/privateStorageService.js');
document.head.appendChild(storageScript);

// Ensure global font for any inline elements we create
try {
  const fontStyle = document.createElement('style');
  fontStyle.textContent = `
    .voidr-rec-panel, .voidr-rec-panel *, .voidr-rec-countdown { font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, system-ui, sans-serif !important; }
    #voidr-testing-widget, #voidr-testing-widget * { font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, system-ui, sans-serif !important; }
  `;
  document.head.appendChild(fontStyle);
} catch (_) {}

// Content script initialization
async function initVoidrExtension() {
  try {
    console.log('Initializing Voidr Extension...');

    // Always ensure the refocus button is present, independent of auth
    createRefocusButton();
    ensureRefocusButtonPresent();
    try {
      // Reinsert defensively on navigation/visibility changes
      if (!window.__voidr_refocus_check__) {
        window.__voidr_refocus_check__ = setInterval(() => {
          try {
            ensureRefocusButtonPresent();
          } catch (_) {}
        }, 3000);
      }
      ['visibilitychange', 'pageshow', 'focus', 'popstate', 'hashchange'].forEach((evt) => {
        try {
          window.addEventListener(evt, ensureRefocusButtonPresent, { passive: true });
        } catch (_) {}
      });
    } catch (_) {}

    // Check authentication first
    const authStatus = await getAuthStatus();
    console.log('Content script auth status:', authStatus);

    if (!authStatus.isAuthenticated) {
      console.log('User not authenticated yet – refocus button is available to open popup');
      // Keep the button visible; do not return early to allow focus/open
    }

    if (!authStatus.token) {
      console.warn('User authenticated but no JWT token available');
      return;
    }

    console.log('JWT token available, proceeding with widget creation');

    // Load settings
    voidrSettings = await getSettings();

    // Inicializa test planning context (force fresh on each init)
    try {
      // wait service and clear cache to force fresh
      let tries = 0;
      while (!window.testPlanningService && tries < 30) {
        await new Promise((r) => setTimeout(r, 100));
        tries++;
      }
      if (
        window.testPlanningService &&
        typeof window.testPlanningService.clearCache === 'function'
      ) {
        window.testPlanningService.clearCache();
      }
    } catch (_) {}
    await initializeTestPlanningContext();

    // Remove old floating widget and keep only the refocus button
    try {
      const oldWidget = document.getElementById('voidr-testing-widget');
      if (oldWidget) oldWidget.remove();
      const oldFloat = document.getElementById('voidr-floating-btn');
      if (oldFloat && oldFloat.parentElement) oldFloat.parentElement.remove();
    } catch (_) {}

    // Create floating button to refocus/open the popup window
    createRefocusButton();

    console.log('Voidr Extension initialized successfully for:', authStatus.user?.email);
  } catch (error) {
    console.error('Error initializing Voidr Extension:', error);
  }
}

// Fetch settings from storage
function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
      resolve(response || {});
    });
  });
}

// Fetch authentication status
function getAuthStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getAuthStatus' }, (response) => {
      resolve(response || { isAuthenticated: false });
    });
  });
}

// Inicializa contexto de test planning
async function initializeTestPlanningContext() {
  try {
    console.log('Initializing test planning context...');

    // Wait for test planning service to load
    let attempts = 0;
    while (!window.testPlanningService && attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!window.testPlanningService) {
      console.warn('Test planning service not loaded');
      return;
    }

    // Initialize for current page
    testPlanningContext = await window.testPlanningService.initializeForCurrentPage();
    console.log('Test planning context:', testPlanningContext);

    if (testPlanningContext.hasApplication) {
      console.log(`✅ Application found: ${testPlanningContext.application.name}`);

      if (testPlanningContext.hasTestPlan) {
        console.log(`✅ Test plan found: ${testPlanningContext.testPlan.name}`);
        console.log(`📋 Modules available: ${testPlanningContext.content.modules.length}`);
      } else {
        console.log('⚠️ No test plan found for this application');
      }
    } else {
      console.log('ℹ️ No Voidr application configured for this URL');
    }
  } catch (error) {
    console.error('Error initializing test planning context:', error);
    testPlanningContext = { hasApplication: false, error: error.message };
  }
}

// Cria o widget principal
function createVoidrWidget() {
  if (voidrWidget) return;

  // Container principal do widget
  voidrWidget = document.createElement('div');
  voidrWidget.id = 'voidr-testing-widget';
  voidrWidget.className = 'voidr-widget-container';

  // Botão flutuante para abrir/fechar
  const floatingButton = document.createElement('div');
  floatingButton.id = 'voidr-floating-btn';
  floatingButton.className = 'voidr-floating-button';
  floatingButton.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  `;
  floatingButton.title = 'Voidr Testing Assistant';

  // Panel do widget (inicialmente oculto)
  const widgetPanel = document.createElement('div');
  widgetPanel.id = 'voidr-widget-panel';
  widgetPanel.className = 'voidr-widget-panel voidr-hidden';
  widgetPanel.innerHTML = `
    <div class="voidr-widget-header">
      <h3>Voidr Testing Assistant</h3>
      <button id="voidr-close-btn" class="voidr-close-button">×</button>
    </div>
    <div class="voidr-widget-content">
      <div id="voidr-main-content">
        <!-- Will be populated by navigation system -->
      </div>
    </div>
  `;

  // Adiciona elementos ao DOM
  voidrWidget.appendChild(floatingButton);
  voidrWidget.appendChild(widgetPanel);
  document.body.appendChild(voidrWidget);

  // Adiciona event listeners
  setupWidgetListeners();

  // Não usamos mais o widget embutido na página
}

// Configura listeners do widget
function setupWidgetListeners() {
  const floatingButton = document.getElementById('voidr-floating-btn');
  const closeButton = document.getElementById('voidr-close-btn');
  const widgetPanel = document.getElementById('voidr-widget-panel');

  // Toggle do widget
  floatingButton?.addEventListener('click', () => {
    toggleWidget();
  });

  // Fechar widget
  closeButton?.addEventListener('click', () => {
    hideWidget();
  });

  // Navigation system will be handled by showWelcomeScreen and other navigation functions

  // Fechar widget ao clicar fora
  document.addEventListener('click', (e) => {
    if (isWidgetVisible && !voidrWidget?.contains(e.target)) {
      hideWidget();
    }
  });
}

// Setup page listeners
function setupPageListeners() {
  // Listener to detect changes in the page
  const observer = new MutationObserver((mutations) => {
    // Implement logic to detect relevant changes here
    console.log('Detected changes in page:', mutations.length);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });
}

// New: Create floating refocus button only
function createRefocusButton() {
  try {
    console.log('[Voidr] Creating refocus button (shadow host)');
    // Remove legacy instances
    const oldHost = document.getElementById('voidr-refocus-host');
    if (oldHost) oldHost.remove();

    // Create host positioned at bottom-right with exact z-index requirement
    const host = document.createElement('div');
    host.id = 'voidr-refocus-host';
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '16px';
    host.style.zIndex = '1000000';
    host.style.width = '56px';
    host.style.height = '56px';
    host.style.pointerEvents = 'auto';
    document.documentElement.appendChild(host);

    // Attach shadow root to isolate from page CSS
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .btn { 
        all: initial; 
        display: inline-flex; align-items: center; justify-content: center;
        width: 56px; height: 56px; border-radius: 50%; background: #000; color: #fff; 
        border: 1px solid rgba(255,255,255,0.18); cursor: pointer; 
        box-shadow: 0 10px 30px rgba(0,0,0,0.45);
      }
      .btn:hover { box-shadow: 0 14px 36px rgba(0,0,0,0.55); }
      svg { width: 26px; height: 26px; display:block; }
    `;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.title = 'Open Voidr Assistant';
    btn.innerHTML = `
      <svg viewBox="0 0 4521 4521" xmlns="http://www.w3.org/2000/svg" fill="white" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M2260.5 4521C3508.94 4521 4521 3508.94 4521 2260.49C4521 1012.06 3508.94 0 2260.5 0C1012.06 0 0 1012.06 0 2260.49C0 3508.94 1012.06 4521 2260.5 4521ZM3334.24 2024.28C3334.24 2154.74 3228.47 2260.49 3098.02 2260.49H2504.44C2373.99 2260.49 2268.22 2366.26 2268.22 2496.72V3098.01C2268.22 3228.48 2162.46 3334.24 2032.01 3334.24H1422.98C1292.52 3334.24 1186.76 3228.48 1186.76 3098.01V2496.72C1186.76 2366.26 1292.52 2260.49 1422.98 2260.49H2016.56C2147.01 2260.49 2252.78 2154.74 2252.78 2024.28V1422.99C2252.78 1292.52 2358.53 1186.76 2488.99 1186.76H3098.02C3228.47 1186.76 3334.24 1292.52 3334.24 1422.99V2024.28Z"/>
      </svg>
    `;
    shadow.appendChild(style);
    shadow.appendChild(btn);

    // Click handler
    btn.addEventListener('click', () => {
      try {
        const rect = host.getBoundingClientRect();
        const left = Math.round(rect.left + window.screenX - (472 - rect.width));
        const top = Math.round(rect.top + window.screenY - 625);
        console.log('[Voidr] Refocus button clicked, requesting popup at', { left, top });
        chrome.runtime.sendMessage(
          {
            action: 'focusOrOpenPopup',
            position: { left, top },
          },
          () => {},
        );
      } catch (e) {}
    });
  } catch (e) {}
}

// Ensure the refocus button exists; if missing, recreate it
function ensureRefocusButtonPresent() {
  try {
    const host = document.getElementById('voidr-refocus-host');
    if (!host) {
      createRefocusButton();
    }
  } catch (_) {}
}

// Session recording overlay + collector
async function startVoidrSessionRecording(testCaseName, options = {}) {
  try {
    const { mode, slug, userId, effectiveName } = buildRecordingContext(testCaseName, options);
    // Remove existing overlays
    document
      .querySelectorAll('.voidr-rec-border, .voidr-rec-countdown, .voidr-rec-panel')
      .forEach((n) => n.remove());

    // Countdown 3..2..1
    const countdown = document.createElement('div');
    countdown.className = 'voidr-rec-countdown';
    document.documentElement.appendChild(countdown);
    const border = document.createElement('div');
    border.className =
      'voidr-rec-border' +
      (options && options.mode === 'defect' ? ' voidr-rec-border--defect' : '');
    document.documentElement.appendChild(border);

    let value = 3;
    countdown.textContent = String(value);
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        value -= 1;
        if (value <= 0) {
          clearInterval(timer);
          resolve();
        } else {
          countdown.textContent = String(value);
        }
      }, 1000);
    });
    countdown.remove();

    // Panel with controls (render first to guarantee visibility)
    const panel = document.createElement('div');
    panel.className = 'voidr-rec-panel';
    panel.style.cssText = '';
    panel.innerHTML = `
      <div class="voidr-rec-icon">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="#ef4444"><circle cx="12" cy="12" r="6" /></svg>
      </div>
      <div class="voidr-rec-title">Recording session for &quot;${escapeHtml(
        effectiveName,
      )}&quot;</div>
      <div class="voidr-rec-actions">
        <button class="voidr-rec-btn" id="voidr-rec-rollback">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="1 4 1 10 7 10"></polyline>
            <path d="M3.51 15A9 9 0 1 0 7 4.6"></path>
          </svg>
          Rollback
        </button>
        <button class="voidr-rec-btn danger" id="voidr-rec-stop">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect>
          </svg>
          Stop
        </button>
      </div>
    `;
    document.documentElement.appendChild(panel);

    // Request background to inject official collector in MAIN world (CSP-safe) and init
    try {
      // Use dynamic apiKey from customer-configs
      makeAuthenticatedRequest('/customer-configs', 'GET')
        .then((cfg) => {
          const cd = cfg && (cfg.data || cfg);
          const apiKey = cd?.apiKey || cd?.data?.apiKey;
          sendCollectorInit({ mode, slug, userId, effectiveName, apiKey });
        })
        .catch(() => {
          sendCollectorInit({ mode, slug, userId, effectiveName, apiKey: undefined });
        });
    } catch (_) {}

    // Handlers
    document.getElementById('voidr-rec-rollback')?.addEventListener('click', () => {
      // Restart without removing collector (keeps running)
      startVoidrSessionRecording(testCaseName);
    });
    document.getElementById('voidr-rec-stop')?.addEventListener('click', () => {
      border.remove();
      panel.remove();
      document.querySelectorAll('.voidr-rec-countdown').forEach((n) => n.remove());
      try {
        // Inform background to read sessionId and broadcast
        chrome.runtime.sendMessage({ action: 'voidr:sessionStopped' });
      } catch (_) {}
    });
  } catch (e) {
    console.error('Voidr session recording error:', e);
  }
}

// Deprecated: collector injection handled by background in MAIN world to satisfy CSP

function escapeHtml(str) {
  try {
    return str.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]),
    );
  } catch (_) {
    return str;
  }
}

// Recording helpers
function buildRecordingContext(providedName, options = {}) {
  const mode = options && options.mode ? options.mode : 'test-case';
  const slug = options && options.slug ? options.slug : undefined;
  const timestamp = new Date().toISOString();
  const effectiveName =
    providedName && String(providedName).trim()
      ? providedName
      : mode === 'defect'
      ? `Sample Defect ${timestamp}`
      : `Sample Test Case ${timestamp}`;
  const userId = mode === 'defect' ? 'voidr-defect-assistant' : 'voidr-test-case-assistant';
  return { mode, slug, userId, effectiveName };
}

function sendCollectorInit(init) {
  try {
    chrome.runtime.sendMessage(
      {
        action: 'voidr:injectCollectorAndInit',
        initOptions: {
          user: { id: init.userId },
          apiKey: init.apiKey,
          system: true,
          url: window.location.href,
          meta: { testCase: init.effectiveName, mode: init.mode, slug: init.slug },
        },
      },
      () => {},
    );
  } catch (_) {}
}

// Funções do widget
function toggleWidget() {
  if (isWidgetVisible) {
    hideWidget();
  } else {
    showWidget();
  }
}

function showWidget() {
  const panel = document.getElementById('voidr-widget-panel');
  panel?.classList.remove('voidr-hidden');
  isWidgetVisible = true;
}

function hideWidget() {
  const panel = document.getElementById('voidr-widget-panel');
  panel?.classList.add('voidr-hidden');
  isWidgetVisible = false;
}

// Sistema de navegação interno do widget
let currentView = 'welcome';

// Mostra tela de boas-vindas
function showWelcomeScreen() {
  const contentDiv = document.getElementById('voidr-main-content');
  if (!contentDiv) return;

  currentView = 'welcome';

  contentDiv.innerHTML = `
    <div class="voidr-welcome">
      <div class="voidr-welcome-header">
        <div class="voidr-welcome-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <h2>Welcome to Voidr Testing Assistant</h2>
        <p>Your AI-powered testing companion is ready to help you create better tests and catch bugs faster.</p>
      </div>
      
      <div class="voidr-welcome-actions">
        <h3>What would you like to do now?</h3>
        
        <div class="voidr-action-cards">
          <button class="voidr-action-card" onclick="navigateToTestPlanning()">
            <div class="voidr-action-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
                <path d="M8.5 2h7"/>
                <path d="M7 16h10"/>
              </svg>
            </div>
            <div class="voidr-action-content">
              <h4>Plan Tests</h4>
              <p>Create and organize test cases for this application</p>
            </div>
            <div class="voidr-action-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </div>
          </button>
          
          <button class="voidr-action-card" onclick="navigateToBugReport()">
            <div class="voidr-action-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 2v4m8-4v4m-6 4h4m-4 4h4M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2"/>
                <rect x="8" y="6" width="8" height="4" rx="1"/>
              </svg>
            </div>
            <div class="voidr-action-content">
              <h4>Analyze Defects</h4>
              <p>List and report defects on this page</p>
            </div>
            <div class="voidr-action-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </div>
          </button>
        </div>
      </div>
      
      ${
        testPlanningContext
          ? `
        <div class="voidr-context-info">
          ${
            testPlanningContext.hasApplication
              ? `
            <div class="voidr-context-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
              <span>Connected to: <strong>${testPlanningContext.application.name}</strong></span>
            </div>
            ${
              testPlanningContext.hasTestPlan
                ? `
              <div class="voidr-context-item">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
                  <path d="M8.5 2h7"/>
                  <path d="M7 16h10"/>
                </svg>
                <span>Test Plan: <strong>${testPlanningContext.testPlan.name}</strong></span>
              </div>
            `
                : ''
            }
          `
              : `
            <div class="voidr-context-item voidr-context-warning">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>No Voidr application configured for this URL</span>
            </div>
          `
          }
        </div>
      `
          : ''
      }
    </div>
  `;
}

// Funções de navegação
window.navigateToTestPlanning = function () {
  currentView = 'test-planning';
  showTestPlanningView();
};

window.navigateToBugReport = function () {
  currentView = 'bug-report';
  showBugReportView();
};

window.navigateToWelcome = function () {
  currentView = 'welcome';
  showWelcomeScreen();
};

// Mostra view de test planning
function showTestPlanningView() {
  const contentDiv = document.getElementById('voidr-main-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-view-container">
      <div class="voidr-view-header">
        <button onclick="navigateToWelcome()" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          Back
        </button>
        <h3>Test Planning</h3>
      </div>
      <div class="voidr-view-content" id="test-planning-content">
        <!-- Will be populated by updateTestPlanningContent() -->
      </div>
    </div>
  `;

  // Load test planning content
  updateTestPlanningContent();
}

// Mostra view de bug report
function showBugReportView() {
  const contentDiv = document.getElementById('voidr-main-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-view-container">
      <div class="voidr-view-header">
        <button onclick="navigateToWelcome()" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          Back
        </button>
        <h3>Analyze Defects</h3>
      </div>
      <div class="voidr-view-content" id="defects-content">
        <!-- Populated by updateDefectsContent() -->
      </div>
    </div>
  `;

  updateDefectsContent();
}

// Funções de funcionalidade

// Funções antigas removidas - agora usamos o sistema de navegação interno

function captureScreenshot() {
  chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
    if (response?.screenshot) {
      console.log('Screenshot capturado:', response.screenshot.length, 'bytes');
      try {
        chrome.runtime.sendMessage({
          action: 'showToast',
          type: 'success',
          message: 'Screenshot captured successfully!',
        });
      } catch (_) {}
    }
  });
}

// Defects view helpers and handlers
async function updateDefectsContent() {
  const container = document.getElementById('defects-content');
  if (!container) return;

  const appId =
    testPlanningContext?.application?.id || testPlanningContext?.application?._id || null;
  const filters = {
    page: defectsContext.page,
    limit: defectsContext.limit,
    sortBy: 'createdAt',
    sortDir: 'desc',
  };
  if (appId) filters.applicationId = appId;

  container.innerHTML = `
    <div class="voidr-app-context">
      <div class="voidr-app-info">
        <h4>${testPlanningContext?.application?.name || 'Application'}</h4>
        <p>${testPlanningContext?.application?.environment?.name || ''}</p>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="voidr-button-secondary voidr-small" onclick="refreshDefectsList()">Refresh</button>
        <button class="voidr-button-primary voidr-small" onclick="showNewDefectForm()">Report Defect</button>
      </div>
    </div>
    <div id="defects-list">
      <div class="voidr-loading-state"><div class="voidr-loading-spinner"></div><p>Loading defects...</p></div>
    </div>
  `;

  try {
    let tries = 0;
    while (!window.defectsService && tries < 30) {
      await new Promise((r) => setTimeout(r, 100));
      tries += 1;
    }
    if (!window.defectsService) throw new Error('Defects service not available');
    const res = await window.defectsService.listDefects(filters);
    defectsContext.items = res.items || [];
    defectsContext.page = res.page || 1;
    defectsContext.limit = res.limit || 20;
    defectsContext.hasMore = (res.total || 0) > res.page * res.limit;
    renderDefectsList();
  } catch (e) {
    const list = document.getElementById('defects-list');
    if (list)
      list.innerHTML = `<div class=\"voidr-empty-state\"><h4>Failed to load defects</h4><p>${
        (e && e.message) || 'Unknown error'
      }</p></div>`;
  }
}

function renderDefectsList() {
  const list = document.getElementById('defects-list');
  if (!list) return;
  const items = defectsContext.items || [];
  if (!items.length) {
    list.innerHTML = `<div class=\"voidr-empty-state\"><h4>No defects found</h4><p>Create your first defect for this application.</p></div>`;
    return;
  }
  const rows = items
    .map((d) => {
      const status = (d.status || 'open').toLowerCase();
      const sev = (d.severity || 'medium').toLowerCase();
      const pri = (d.priority || 'p2').toUpperCase();
      const title = d.title || d.slug || 'Untitled';
      const slug = d.slug || d._id || '';
      return `
      <div class=\"voidr-defect-item\">
        <div class=\"voidr-defect-main\">
          <div class=\"voidr-defect-title\">${title}</div>
          <div class=\"voidr-defect-meta\">
            <span class=\"voidr-status-badge voidr-status-${status}\">${status}</span>
            <span class=\"voidr-severity-badge voidr-severity-${sev}\">${sev}</span>
            <span class=\"voidr-priority-badge\">${pri}</span>
            ${slug ? `<span class=\"voidr-slug\">${slug}</span>` : ''}
          </div>
        </div>
        <div class=\"voidr-defect-actions\">
          <button class=\"voidr-button-secondary voidr-small\" onclick=\"viewDefect('${encodeURIComponent(
            slug,
          )}')\">View</button>
        </div>
      </div>
    `;
    })
    .join('');
  list.innerHTML = `<div class=\"voidr-defects-list\">${rows}</div>`;
}

window.refreshDefectsList = function () {
  updateDefectsContent();
};

window.showNewDefectForm = function () {
  const container = document.getElementById('defects-content');
  if (!container) return;
  newDefectDraft = { attachments: [], sessionId: lastCapturedSessionId };
  const optApplication = testPlanningContext?.application;
  container.innerHTML = `
    <div class=\"voidr-form-container\">
      <div class=\"voidr-form-header\">
        <button onclick=\"updateDefectsContent()\" class=\"voidr-back-button\">
          <svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><polyline points=\"15,18 9,12 15,6\"/></svg>
          Back
        </button>
        <h4>New Defect</h4>
      </div>

      <div class=\"voidr-app-context\" style=\"margin-bottom:16px;\">
        <div class=\"voidr-app-info\">
          <h4>${optApplication?.name || 'Application'}</h4>
          <p>${optApplication?.environment?.name || ''}</p>
        </div>
        <div style=\"display:flex; gap:8px;\">
          <button class=\"voidr-button-secondary voidr-small\" onclick=\"startRecordingForDefect()\">Record Session</button>
          <button class=\"voidr-button-secondary voidr-small\" onclick=\"linkLastSessionForDefect()\" ${
            lastCapturedSessionId ? '' : 'disabled'
          }>${lastCapturedSessionId ? 'Link Last Session' : 'No Session'}</button>
        </div>
      </div>

      <form onsubmit=\"submitNewDefect(event)\">
        <div class=\"voidr-form-group\">
          <label>Title</label>
          <input type=\"text\" id=\"df-title\" placeholder=\"Briefly describe the problem...\" required />
        </div>
        <div class=\"voidr-form-group\">
          <label>Description</label>
          <textarea id=\"df-description\" placeholder=\"Describe the problem in detail...\" required></textarea>
        </div>
        <div class=\"voidr-form-group\">
          <label>Application Environment</label>
          <input id=\"df-env\" type=\"text\" value=\"${
            optApplication?.environment?.name || ''
          }\" placeholder=\"production / staging / development\" />
        </div>
        <div class=\"voidr-form-group\">
          <label>Session</label>
          <input id=\"df-session\" type=\"text\" value=\"${
            lastCapturedSessionId || ''
          }\" placeholder=\"Session ID (optional)\" />
        </div>
        <div class=\"voidr-form-group\">
          <label>Severity</label>
          <select id=\"df-severity\">
            <option value=\"low\">Low</option>
            <option value=\"medium\" selected>Medium</option>
            <option value=\"high\">High</option>
            <option value=\"critical\">Critical</option>
          </select>
        </div>
        <div class=\"voidr-form-group\">
          <label>Priority</label>
          <select id=\"df-priority\">
            <option value=\"p3\">P3</option>
            <option value=\"p2\" selected>P2</option>
            <option value=\"p1\">P1</option>
            <option value=\"p0\">P0</option>
          </select>
        </div>
        <div class=\"voidr-form-group\">
          <label>Reproducibility</label>
          <select id=\"df-repro\">
            <option value=\"always\" selected>Always</option>
            <option value=\"sometimes\">Sometimes</option>
            <option value=\"rarely\">Rarely</option>
            <option value=\"intermittent\">Intermittent</option>
          </select>
        </div>

        <div class=\"voidr-form-group\">
          <label>Attachments</label>
          <input type=\"file\" id=\"df-file\" multiple style=\"display:none\" />
          <div id=\"df-upload-zone\" class=\"voidr-upload-zone\" onclick=\"document.getElementById('df-file').click()\">Click to select files or drop here</div>
          <div id=\"df-uploaded\" class=\"voidr-uploaded-list\" style=\"margin-top:8px;\"></div>
        </div>

        <div class=\"voidr-form-actions\">
          <button type=\"submit\" class=\"voidr-button-primary\">Create Defect</button>
          <button type=\"button\" onclick=\"updateDefectsContent()\" class=\"voidr-button-secondary\">Cancel</button>
        </div>
      </form>
    </div>
  `;

  try {
    const zone = document.getElementById('df-upload-zone');
    const input = document.getElementById('df-file');
    if (zone) {
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('voidr-upload-over');
      });
      zone.addEventListener('dragleave', () => {
        zone.classList.remove('voidr-upload-over');
      });
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('voidr-upload-over');
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) handleFilesUpload(files);
      });
    }
    input?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) handleFilesUpload(files);
    });
  } catch (_) {}
};

async function handleFilesUpload(files) {
  for (const file of files) {
    try {
      let tries = 0;
      while (!window.privateStorageService && tries < 30) {
        await new Promise((r) => setTimeout(r, 100));
        tries += 1;
      }
      if (!window.privateStorageService) throw new Error('Storage service not available');
      const uploaded = await window.defectsService.uploadAttachment(file, {
        pageUrl: window.location.href,
      });
      newDefectDraft.attachments.push(uploaded);
      renderUploadedAttachments();
    } catch (e) {
      alert('Failed to upload file: ' + (e?.message || 'Unknown error'));
    }
  }
}

function renderUploadedAttachments() {
  const list = document.getElementById('df-uploaded');
  if (!list) return;
  if (!newDefectDraft.attachments.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = newDefectDraft.attachments
    .map(
      (a, idx) => `
    <div class=\"voidr-uploaded-item\">
      <div class=\"voidr-uploaded-name\">${a.name}</div>
      <div class=\"voidr-uploaded-actions\">
        <button class=\"voidr-action-btn\" title=\"Remove\" onclick=\"removeUploadedAttachment(${idx})\">
          <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg>
        </button>
      </div>
    </div>
  `,
    )
    .join('');
}

window.removeUploadedAttachment = function (idx) {
  if (idx >= 0 && idx < newDefectDraft.attachments.length) {
    newDefectDraft.attachments.splice(idx, 1);
    renderUploadedAttachments();
  }
};

window.startRecordingForDefect = function () {
  const titleEl = document.getElementById('df-title');
  const name = titleEl && titleEl.value ? titleEl.value : 'Defect Session';
  try {
    startVoidrSessionRecording(name, { mode: 'defect' });
  } catch (_) {}
};

window.linkLastSessionForDefect = function () {
  if (lastCapturedSessionId) {
    newDefectDraft.sessionId = lastCapturedSessionId;
    alert('Linked session: ' + lastCapturedSessionId);
  }
};

window.viewDefect = async function (idOrSlug) {
  try {
    let tries = 0;
    while (!window.defectsService && tries < 30) {
      await new Promise((r) => setTimeout(r, 100));
      tries += 1;
    }
    if (!window.defectsService) throw new Error('Defects service not available');
    const defect = await window.defectsService.getDefect(decodeURIComponent(idOrSlug));
    const container = document.getElementById('defects-content');
    if (!container) return;
    const status = (defect.status || 'open').toLowerCase();
    const sev = (defect.severity || 'medium').toLowerCase();
    const pri = (defect.priority || 'p2').toUpperCase();
    container.innerHTML = `
      <div class=\"voidr-form-header\">
        <button onclick=\"updateDefectsContent()\" class=\"voidr-back-button\">
          <svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><polyline points=\"15,18 9,12 15,6\"/></svg>
          Back
        </button>
        <h4>${defect.title || defect.slug}</h4>
      </div>
      <div class=\"voidr-app-context\">
        <div class=\"voidr-app-info\">
          <p>Status: <span class=\"voidr-status-badge voidr-status-${status}\">${status}</span></p>
          <p>Severity: <span class=\"voidr-severity-badge voidr-severity-${sev}\">${sev}</span> • Priority: <span class=\"voidr-priority-badge\">${pri}</span></p>
        </div>
      </div>
      <div style=\"margin-top:12px;\">
        <p style=\"white-space:pre-wrap; color: var(--text-primary);\">${(
          defect.description || ''
        ).replace(/</g, '&lt;')}</p>
      </div>
    `;
  } catch (e) {
    alert('Failed to open defect: ' + (e?.message || 'Unknown error'));
  }
};

window.submitNewDefect = async function (event) {
  event.preventDefault();
  const title = document.getElementById('df-title').value.trim();
  const description = document.getElementById('df-description').value.trim();
  const envName =
    (document.getElementById('df-env') && document.getElementById('df-env').value.trim()) || '';
  const sessionInput =
    (document.getElementById('df-session') && document.getElementById('df-session').value.trim()) ||
    '';
  const severity = document.getElementById('df-severity').value;
  const priority = document.getElementById('df-priority').value;
  const reproducibility = document.getElementById('df-repro').value;
  if (!title || !description) {
    alert('Please fill title and description');
    return;
  }
  try {
    let tries = 0;
    while (!window.defectsService && tries < 30) {
      await new Promise((r) => setTimeout(r, 100));
      tries += 1;
    }
    if (!window.defectsService) throw new Error('Defects service not available');
    const app = testPlanningContext?.application || {};
    // Normalize environment enum
    const envLower = String(
      envName || (app.environment && (app.environment.type || app.environment.name)) || '',
    ).toLowerCase();
    const envNormalized = ['production', 'staging', 'development'].includes(envLower)
      ? envLower
      : envLower.startsWith('prod')
      ? 'production'
      : envLower.startsWith('stag')
      ? 'staging'
      : 'development';
    // Reporter from content auth status
    const auth = await getAuthStatus();
    const reporter =
      (auth && auth.user && (auth.user.id || auth.user._id || auth.user.email)) || undefined;
    const payload = {
      title,
      description,
      severity,
      priority,
      status: 'open',
      reproducibility,
      applicationId: app.id || app._id,
      applicationEnvironment: envNormalized,
      reportedBy: reporter,
      platform: { os: navigator.platform, browser: navigator.userAgent },
      attachments: newDefectDraft.attachments || [],
      sessions: sessionInput
        ? [sessionInput]
        : newDefectDraft.sessionId
        ? [newDefectDraft.sessionId]
        : [],
    };
    await window.defectsService.createDefect(payload);
    alert('Defect created successfully');
    updateDefectsContent();
  } catch (e) {
    alert('Failed to create defect: ' + (e?.message || 'Unknown error'));
  }
};

// Listener para mensagens do background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Mensagem recebida no content script:', request);

  switch (request.action) {
    case 'toggleWidget':
      toggleWidget();
      break;
    case 'injectWidget':
      if (!voidrWidget) {
        createVoidrWidget();
      }
      break;
    case 'authenticationCompleted':
      console.log('Authentication completed, initializing widget...');
      // Re-inicializa a extensão agora que o usuário está autenticado
      initVoidrExtension();

      // Mostra notificação de sucesso
      showAuthSuccessNotification();
      break;
    case 'voidr:startSessionRecording':
      startVoidrSessionRecording(request.testCaseName || 'Test Case', {
        mode: request.mode,
        slug: request.slug,
      });
      break;
    case 'voidr:sessionCaptured':
      if (request.sessionId) {
        lastCapturedSessionId = request.sessionId;
        broadcastSessionToOnboarding(request.sessionId);
        showOnboardingDoneBanner();
      }
      break;
  }
  // Signal background we are ready to receive forwards
  try {
    chrome.runtime.sendMessage({ action: 'contentReady' });
  } catch (_) {}
});

// Mostra notificação de sucesso da autenticação
function showAuthSuccessNotification() {
  // Cria notificação temporária
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: var(--background-elevated);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 16px 20px;
    border-radius: 8px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 14px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 10px;
    animation: slideInRight 0.3s ease;
  `;

  notification.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
    Voidr Extension Connected!
  `;

  document.body.appendChild(notification);

  // Remove após 4 segundos
  setTimeout(() => {
    notification.style.animation = 'slideOutRight 0.3s ease';
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 4000);
}

// Adiciona animações CSS para as notificações
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
  @keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  
  @keyframes slideOutRight {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(notificationStyles);

// Faz requisições autenticadas via background script
function makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: 'apiRequest',
        endpoint: endpoint,
        method: method,
        data: data,
      },
      (response) => {
        resolve(response || { error: 'No response' });
      },
    );
  });
}

// Atualiza conteúdo da aba de test planning
function updateTestPlanningContent() {
  const contentDiv = document.getElementById('test-planning-content');
  if (!contentDiv) return;

  if (!testPlanningContext) {
    contentDiv.innerHTML = `
      <div class="voidr-loading-state">
        <div class="voidr-loading-spinner"></div>
        <p>Loading test planning context...</p>
      </div>
    `;
    return;
  }

  if (!testPlanningContext.hasApplication) {
    contentDiv.innerHTML = `
      <div class="voidr-empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15,3 21,3 21,9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        <h4>No Application Found</h4>
        <p>This URL is not configured in any Voidr application.</p>
        <button onclick="refreshTestPlanningContext()" class="voidr-button-secondary">Refresh</button>
      </div>
    `;
    return;
  }

  if (!testPlanningContext.hasTestPlan) {
    contentDiv.innerHTML = `
      <div class="voidr-app-context">
        <div class="voidr-app-info">
          <h4>📱 ${testPlanningContext.application.name}</h4>
          <p>Environment: ${testPlanningContext.application.environment.name}</p>
        </div>
        <div class="voidr-empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
            <path d="M8.5 2h7"/>
            <path d="M7 16h10"/>
          </svg>
          <h4>No Test Plan Found</h4>
          <p>Create a test plan for this application to start testing.</p>
        </div>
      </div>
    `;
    return;
  }

  // Render full test planning interface
  renderTestPlanningInterface(contentDiv);
}

// Renderiza interface completa de test planning
function renderTestPlanningInterface(container) {
  const { testPlan, content, application } = testPlanningContext;

  container.innerHTML = `
    <div class="voidr-test-planning">
      <!-- Header with application info -->
      <div class="voidr-app-context">
        <div class="voidr-app-info">
          <h4>📱 ${application.name}</h4>
          <p>${testPlan.name} (${content.modules.length} modules)</p>
        </div>
        <button onclick="refreshTestPlanningContext()" class="voidr-button-secondary voidr-small">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="1,4 1,10 7,10"/>
            <polyline points="23,20 23,14 17,14"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
          </svg>
        </button>
      </div>
      
      <!-- Modules list -->
      <div class="voidr-modules-list">
        ${content.modules
          .map(
            (module) => `
          <div class="voidr-module" data-module-id="${module.id}">
            <div class="voidr-module-header" onclick="toggleModule('${module.id}')">
              <div class="voidr-module-info">
                <h5>${module.name}</h5>
                <span class="voidr-severity voidr-severity-${module.severity.toLowerCase()}">${
              module.severity
            }</span>
              </div>
              <div class="voidr-module-stats">
                ${module.suites.length} suites
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9,18 15,12 9,6"/>
                </svg>
              </div>
            </div>
            <div class="voidr-module-content" id="module-${module.id}" style="display: none;">
              ${module.suites
                .map(
                  (suite) => `
                <div class="voidr-suite" data-suite-id="${suite.id}">
                  <div class="voidr-suite-header" onclick="toggleSuite('${module.id}', '${
                    suite.id
                  }')">
                    <div class="voidr-suite-info">
                      <h6>${suite.name}</h6>
                      <span class="voidr-suite-count">${suite.cases.length} cases</span>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="9,18 15,12 9,6"/>
                    </svg>
                  </div>
                  <div class="voidr-suite-content" id="suite-${module.id}-${
                    suite.id
                  }" style="display: none;">
                    ${suite.cases
                      .map(
                        (testCase) => `
                      <div class="voidr-test-case" data-case-id="${testCase.slug}">
                        <div class="voidr-test-case-info">
                          <span class="voidr-test-case-name">${testCase.name}</span>
                          <p class="voidr-test-case-objective">${
                            testCase.objective || 'No objective defined'
                          }</p>
                        </div>
                      </div>
                    `,
                      )
                      .join('')}
                    <button onclick="addTestCase('${module.slug}', '${
                    suite.slug
                  }')" class="voidr-button-secondary voidr-small voidr-add-case">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                      </svg>
                      Add Test Case
                    </button>
                  </div>
                </div>
              `,
                )
                .join('')}
              <button onclick="addSuite('${
                module.slug
              }')" class="voidr-button-secondary voidr-small">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add Suite
              </button>
            </div>
          </div>
        `,
          )
          .join('')}
      </div>
      
      <!-- Quick add section -->
      <div class="voidr-quick-add">
        <button onclick="showQuickTestCaseForm()" class="voidr-button-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
            <path d="M8.5 2h7"/>
            <path d="M7 16h10"/>
          </svg>
          Quick Test Case
        </button>
        <button onclick="addModule()" class="voidr-button-secondary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Module
        </button>
      </div>
    </div>
  `;
}

// Funções globais para interação com test planning
window.refreshTestPlanningContext = async function () {
  await initializeTestPlanningContext();
  updateTestPlanningContent();
};

window.toggleModule = function (moduleId) {
  const moduleContent = document.getElementById(`module-${moduleId}`);
  if (moduleContent) {
    const isVisible = moduleContent.style.display !== 'none';
    moduleContent.style.display = isVisible ? 'none' : 'block';

    // Update chevron rotation
    const moduleHeader = moduleContent.previousElementSibling;
    const chevron = moduleHeader?.querySelector('svg');
    if (chevron) {
      chevron.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(90deg)';
    }
  }
};

window.toggleSuite = function (moduleId, suiteId) {
  const suiteContent = document.getElementById(`suite-${moduleId}-${suiteId}`);
  if (suiteContent) {
    const isVisible = suiteContent.style.display !== 'none';
    suiteContent.style.display = isVisible ? 'none' : 'block';

    // Update chevron rotation
    const suiteHeader = suiteContent.previousElementSibling;
    const chevron = suiteHeader?.querySelector('svg');
    if (chevron) {
      chevron.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(90deg)';
    }
  }
};

window.addTestCase = function (moduleSlug, suiteSlug) {
  showTestCaseForm(moduleSlug, suiteSlug);
};

window.addSuite = function (moduleSlug) {
  showSuiteForm(moduleSlug);
};

window.addModule = function () {
  showModuleForm();
};

window.showQuickTestCaseForm = function () {
  // Show form to select module/suite or create new ones
  showQuickTestCaseDialog();
};

// Show test case creation form
function showTestCaseForm(moduleSlug, suiteSlug) {
  const contentDiv = document.getElementById('test-planning-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button onclick="showTestPlanningView()" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          Back
        </button>
        <h4>New Test Case</h4>
      </div>
      
      <form class="voidr-test-case-form" onsubmit="submitTestCase(event, '${moduleSlug}', '${suiteSlug}')">
        <div class="voidr-form-group">
          <label>Test Case Name:</label>
          <input type="text" id="tc-name" placeholder="Enter test case name..." required>
        </div>
        
        <div class="voidr-form-group">
          <label>Objective:</label>
          <textarea id="tc-objective" placeholder="What should this test verify?" rows="3"></textarea>
        </div>
        
        <div class="voidr-form-group">
          <label>Prerequisites:</label>
          <textarea id="tc-prerequisites" placeholder="What needs to be set up before this test?" rows="2"></textarea>
        </div>
        
        <div class="voidr-form-group">
          <label>Expected Result:</label>
          <textarea id="tc-expected" placeholder="What should happen when the test passes?" rows="3"></textarea>
        </div>
        
        <div class="voidr-form-actions">
          <button type="submit" class="voidr-button-primary">Create Test Case</button>
          <button type="button" onclick="showTestPlanningView()" class="voidr-button-secondary">Cancel</button>
        </div>
      </form>
    </div>
  `;
}

// Show suite creation form
function showSuiteForm(moduleSlug) {
  const contentDiv = document.getElementById('test-planning-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button onclick="showTestPlanningView()" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          Back
        </button>
        <h4>New Test Suite</h4>
      </div>
      
      <form class="voidr-suite-form" onsubmit="submitSuite(event, '${moduleSlug}')">
        <div class="voidr-form-group">
          <label>Suite Name:</label>
          <input type="text" id="suite-name" placeholder="Enter suite name..." required>
        </div>
        
        <div class="voidr-form-group">
          <label>Description:</label>
          <textarea id="suite-description" placeholder="Describe this test suite..." rows="3"></textarea>
        </div>
        
        <div class="voidr-form-actions">
          <button type="submit" class="voidr-button-primary">Create Suite</button>
          <button type="button" onclick="showTestPlanningView()" class="voidr-button-secondary">Cancel</button>
        </div>
      </form>
    </div>
  `;
}

// Show module creation form
function showModuleForm() {
  const contentDiv = document.getElementById('test-planning-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button onclick="showTestPlanningView()" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          Back
        </button>
        <h4>New Module</h4>
      </div>
      
      <form class="voidr-module-form" onsubmit="submitModule(event)">
        <div class="voidr-form-group">
          <label>Module Name:</label>
          <input type="text" id="module-name" placeholder="Enter module name..." required>
        </div>
        
        <div class="voidr-form-group">
          <label>Description:</label>
          <textarea id="module-description" placeholder="Describe this module..." rows="3"></textarea>
        </div>
        
        <div class="voidr-form-group">
          <label>Severity:</label>
          <select id="module-severity" required>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
            <option value="LOW">Low</option>
          </select>
        </div>
        
        <div class="voidr-form-actions">
          <button type="submit" class="voidr-button-primary">Create Module</button>
          <button type="button" onclick="showTestPlanningView()" class="voidr-button-secondary">Cancel</button>
        </div>
      </form>
    </div>
  `;
}

// Submit functions
window.submitTestCase = async function (event, moduleSlug, suiteSlug) {
  event.preventDefault();

  const name = document.getElementById('tc-name').value;
  const objective = document.getElementById('tc-objective').value;
  const prerequisites = document.getElementById('tc-prerequisites').value;
  const expectedResult = document.getElementById('tc-expected').value;

  if (!name.trim()) {
    alert('Please enter a test case name');
    return;
  }

  try {
    const testCaseData = {
      name: name.trim(),
      objective: objective.trim(),
      prerequisites: prerequisites.trim() ? [prerequisites.trim()] : [],
      expectedResult: expectedResult.trim(),
      attachments: [],
    };

    await window.testPlanningService.createTestCase(
      testPlanningContext.testPlan.id,
      moduleSlug,
      suiteSlug,
      testCaseData,
    );

    // Refresh context and return to main view
    await initializeTestPlanningContext();
    showTestPlanningView();

    alert('Test case created successfully!');
  } catch (error) {
    console.error('Error creating test case:', error);
    alert('Error creating test case: ' + error.message);
  }
};

window.submitSuite = async function (event, moduleSlug) {
  event.preventDefault();

  const name = document.getElementById('suite-name').value;
  const description = document.getElementById('suite-description').value;

  if (!name.trim()) {
    alert('Please enter a suite name');
    return;
  }

  try {
    const suiteData = {
      name: name.trim(),
      description: description.trim(),
    };

    await window.testPlanningService.createSuite(
      testPlanningContext.testPlan.id,
      moduleSlug,
      suiteData,
    );

    // Refresh context and return to main view
    await initializeTestPlanningContext();
    showTestPlanningView();

    alert('Test suite created successfully!');
  } catch (error) {
    console.error('Error creating suite:', error);
    alert('Error creating suite: ' + error.message);
  }
};

window.submitModule = async function (event) {
  event.preventDefault();

  const name = document.getElementById('module-name').value;
  const description = document.getElementById('module-description').value;
  const severity = document.getElementById('module-severity').value;

  if (!name.trim()) {
    alert('Please enter a module name');
    return;
  }

  try {
    const moduleData = {
      name: name.trim(),
      description: description.trim(),
      severity: severity,
    };

    await window.testPlanningService.createModule(testPlanningContext.testPlan.id, moduleData);

    // Refresh context and return to main view
    await initializeTestPlanningContext();
    showTestPlanningView();

    alert('Module created successfully!');
  } catch (error) {
    console.error('Error creating module:', error);
    alert('Error creating module: ' + error.message);
  }
};

// Quick test case dialog
function showQuickTestCaseDialog() {
  if (!testPlanningContext?.hasTestPlan || !testPlanningContext.content.modules.length) {
    alert('Please create a module and suite first');
    return;
  }

  const modules = testPlanningContext.content.modules;
  const moduleOptions = modules
    .map((m) => `<option value="${m.slug}">${m.name} (${m.suites.length} suites)</option>`)
    .join('');

  const contentDiv = document.getElementById('test-planning-content');
  contentDiv.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button onclick="showTestPlanningView()" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
          Back
        </button>
        <h4>Quick Test Case</h4>
      </div>
      
      <form class="voidr-quick-form" onsubmit="submitQuickTestCase(event)">
        <div class="voidr-form-group">
          <label>Module:</label>
          <select id="quick-module" onchange="updateSuiteOptions()" required>
            <option value="">Select module...</option>
            ${moduleOptions}
          </select>
        </div>
        
        <div class="voidr-form-group">
          <label>Suite:</label>
          <select id="quick-suite" required>
            <option value="">Select module first...</option>
          </select>
        </div>
        
        <div class="voidr-form-group">
          <label>Test Case Name:</label>
          <input type="text" id="quick-tc-name" placeholder="Enter test case name..." required>
        </div>
        
        <div class="voidr-form-group">
          <label>What should this test verify?</label>
          <textarea id="quick-tc-objective" placeholder="Describe the test objective..." rows="3" required></textarea>
        </div>
        
        <div class="voidr-form-actions">
          <button type="submit" class="voidr-button-primary">Create Test Case</button>
          <button type="button" onclick="showTestPlanningView()" class="voidr-button-secondary">Cancel</button>
        </div>
      </form>
    </div>
  `;
}

window.updateSuiteOptions = function () {
  const moduleSelect = document.getElementById('quick-module');
  const suiteSelect = document.getElementById('quick-suite');

  if (!moduleSelect || !suiteSelect) return;

  const selectedModuleSlug = moduleSelect.value;
  if (!selectedModuleSlug) {
    suiteSelect.innerHTML = '<option value="">Select module first...</option>';
    return;
  }

  const module = testPlanningContext.content.modules.find((m) => m.slug === selectedModuleSlug);
  if (!module) return;

  const suiteOptions = module.suites
    .map((s) => `<option value="${s.slug}">${s.name} (${s.cases.length} cases)</option>`)
    .join('');

  suiteSelect.innerHTML = `
    <option value="">Select suite...</option>
    ${suiteOptions}
  `;
};

window.submitQuickTestCase = async function (event) {
  event.preventDefault();

  const moduleSlug = document.getElementById('quick-module').value;
  const suiteSlug = document.getElementById('quick-suite').value;
  const name = document.getElementById('quick-tc-name').value;
  const objective = document.getElementById('quick-tc-objective').value;

  if (!moduleSlug || !suiteSlug || !name.trim() || !objective.trim()) {
    alert('Please fill in all required fields');
    return;
  }

  try {
    const testCaseData = {
      name: name.trim(),
      objective: objective.trim(),
      prerequisites: [],
      expectedResult: '',
      attachments: [],
    };

    await window.testPlanningService.createTestCase(
      testPlanningContext.testPlan.id,
      moduleSlug,
      suiteSlug,
      testCaseData,
    );

    // Refresh and return to main view
    await initializeTestPlanningContext();
    showTestPlanningView();

    alert('Test case created successfully!');
  } catch (error) {
    console.error('Error creating quick test case:', error);
    alert('Error creating test case: ' + error.message);
  }
};

// ── Onboarding auto-record via query params ──────────────────────────────────

function checkOnboardingAutoRecord() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('voidr_record') !== '1') return;

    const sessionName = params.get('voidr_session_name') || 'Onboarding Session';
    const mode = params.get('voidr_mode') || 'onboarding';
    const appId = params.get('voidr_app_id') || undefined;
    let flows = [];
    try { flows = JSON.parse(params.get('voidr_flows') || '[]'); } catch (_) {}

    const cleanUrl = new URL(window.location.href);
    ['voidr_record', 'voidr_session_name', 'voidr_mode', 'voidr_app_id', 'voidr_flows'].forEach(
      (k) => cleanUrl.searchParams.delete(k),
    );
    window.history.replaceState({}, '', cleanUrl.toString());

    const waitForAuth = async () => {
      const auth = await getAuthStatus();
      if (!auth.isAuthenticated || !auth.token) {
        console.warn('[Voidr] Auto-record: user not authenticated, skipping');
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
      showOnboardingPreRecordPanel({ sessionName, mode, appId, flows });
    };

    waitForAuth();
  } catch (e) {
    console.error('[Voidr] Auto-record check failed:', e);
  }
}

function showOnboardingPreRecordPanel({ sessionName, mode, appId, flows }) {
  document.querySelectorAll('.voidr-onb-panel').forEach((n) => n.remove());

  const flowsHtml = flows.length
    ? flows.map((f) => `<span class="voidr-onb-flow">${escapeHtml(f.name || f.id)}</span>`).join('')
    : '';

  const panel = document.createElement('div');
  panel.className = 'voidr-onb-panel';
  panel.innerHTML = `
    <div class="voidr-onb-left">
      <svg viewBox="0 0 4521 4521" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="white" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M2260.5 4521C3508.94 4521 4521 3508.94 4521 2260.49C4521 1012.06 3508.94 0 2260.5 0C1012.06 0 0 1012.06 0 2260.49C0 3508.94 1012.06 4521 2260.5 4521ZM3334.24 2024.28C3334.24 2154.74 3228.47 2260.49 3098.02 2260.49H2504.44C2373.99 2260.49 2268.22 2366.26 2268.22 2496.72V3098.01C2268.22 3228.48 2162.46 3334.24 2032.01 3334.24H1422.98C1292.52 3334.24 1186.76 3228.48 1186.76 3098.01V2496.72C1186.76 2366.26 1292.52 2260.49 1422.98 2260.49H2016.56C2147.01 2260.49 2252.78 2154.74 2252.78 2024.28V1422.99C2252.78 1292.52 2358.53 1186.76 2488.99 1186.76H3098.02C3228.47 1186.76 3334.24 1292.52 3334.24 1422.99V2024.28Z"/>
      </svg>
      <div class="voidr-onb-info">
        <div class="voidr-onb-title">Voidr — ${escapeHtml(sessionName)}</div>
        ${flowsHtml ? `<div class="voidr-onb-flows">${flowsHtml}</div>` : ''}
      </div>
    </div>
    <div class="voidr-onb-actions">
      <button type="button" class="voidr-rec-btn" id="voidr-onb-cancel">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Cancelar
      </button>
      <button type="button" class="voidr-rec-btn voidr-onb-play" id="voidr-onb-play">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><polygon points="5,3 19,12 5,21"/></svg>
        Iniciar gravação
      </button>
    </div>
  `;
  document.documentElement.appendChild(panel);

  document.getElementById('voidr-onb-cancel')?.addEventListener('click', () => {
    panel.remove();
  });
  document.getElementById('voidr-onb-play')?.addEventListener('click', () => {
    panel.remove();
    startVoidrSessionRecording(sessionName, { mode, slug: appId });
  });
}

// ── BroadcastChannel for sessionId relay to onboarding widget ─────────────────

function showOnboardingDoneBanner() {
  document.querySelectorAll('.voidr-onb-done').forEach((n) => n.remove());
  const banner = document.createElement('div');
  banner.className = 'voidr-onb-done';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#86efac" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
    Sessão capturada com sucesso — pode fechar esta aba e voltar ao onboarding.
  `;
  document.documentElement.appendChild(banner);
  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 15000);
}

function broadcastSessionToOnboarding(sessionId) {
  try {
    const bc = new BroadcastChannel('voidr-onboarding');
    bc.postMessage({ type: 'voidr:sessionCaptured', sessionId });
    bc.close();
    console.log('[Voidr] Broadcast sessionId to onboarding channel:', sessionId);
  } catch (_) {}
}

// Inicializa quando o DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initVoidrExtension();
    checkOnboardingAutoRecord();
  });
} else {
  initVoidrExtension();
  checkOnboardingAutoRecord();
}
