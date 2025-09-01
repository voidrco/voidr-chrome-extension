// Content script para injeção do widget Voidr nas páginas

console.log('Voidr Testing Assistant - Content script carregado');

// Estado global do widget
let voidrWidget = null;
let isWidgetVisible = false;
let voidrSettings = {};
let testPlanningContext = null;

// Load test planning service
const script = document.createElement('script');
script.src = chrome.runtime.getURL('services/testPlanningService.js');
document.head.appendChild(script);

// Inicialização do content script
async function initVoidrExtension() {
  try {
    console.log('Initializing Voidr Extension...');

    // Verifica autenticação primeiro
    const authStatus = await getAuthStatus();
    console.log('Content script auth status:', authStatus);

    if (!authStatus.isAuthenticated) {
      console.log('User not authenticated, widget not loaded');
      return;
    }

    if (!authStatus.token) {
      console.warn('User authenticated but no JWT token available');
      return;
    }

    console.log('JWT token available, proceeding with widget creation');

    // Carrega configurações
    voidrSettings = await getSettings();

    // Inicializa test planning context
    await initializeTestPlanningContext();

    // Cria o widget se habilitado
    if (voidrSettings.widgetEnabled !== false) {
      createVoidrWidget();
    }

    // Adiciona listeners para eventos da página
    setupPageListeners();

    console.log('Voidr Extension initialized successfully for:', authStatus.user?.email);
  } catch (error) {
    console.error('Error initializing Voidr Extension:', error);
  }
}

// Busca configurações do storage
function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
      resolve(response || {});
    });
  });
}

// Busca status de autenticação
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

  // Mostra tela de boas-vindas
  showWelcomeScreen();
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

// Configura listeners da página
function setupPageListeners() {
  // Listener para detectar mudanças na página
  const observer = new MutationObserver((mutations) => {
    // Aqui podemos implementar lógica para detectar mudanças relevantes
    console.log('Mudanças detectadas na página:', mutations.length);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true
  });
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
              <h4>Report Defects</h4>
              <p>Report bugs and issues found on this page</p>
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
        <h3>Report Defects</h3>
      </div>
      <div class="voidr-view-content">
        <div class="voidr-form-group">
          <label>Bug title:</label>
          <input type="text" id="bug-title" placeholder="Briefly describe the problem...">
        </div>
        <div class="voidr-form-group">
          <label>Severity:</label>
          <select id="bug-severity">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="voidr-form-group">
          <label>Description:</label>
          <textarea id="bug-description" placeholder="Describe the problem in detail..."></textarea>
        </div>
        <div class="voidr-form-group">
          <label>Steps to reproduce:</label>
          <textarea id="bug-steps" placeholder="1. Go to the page...&#10;2. Click on...&#10;3. Notice that..."></textarea>
        </div>
        <div class="voidr-form-actions">
          <button onclick="captureScreenshot()" class="voidr-button-secondary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            Capture Screenshot
          </button>
          <button onclick="reportBug()" class="voidr-button-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 2v4m8-4v4m-6 4h4m-4 4h4M8 8H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2"/>
              <rect x="8" y="6" width="8" height="4" rx="1"/>
            </svg>
            Report Bug
          </button>
        </div>
      </div>
    </div>
  `;
}

// Funções de funcionalidade
function startElementSelection() {
  console.log('Iniciando seleção de elemento...');
  // TODO: Implementar seleção de elementos na página
  alert('Element selection functionality will be implemented in the next iteration');
}

// Funções antigas removidas - agora usamos o sistema de navegação interno

function captureScreenshot() {
  chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
    if (response?.screenshot) {
      console.log('Screenshot capturado:', response.screenshot.length, 'bytes');
      alert('Screenshot captured successfully!');
    }
  });
}

async function reportBug() {
  const title = document.getElementById('bug-title').value;
  const severity = document.getElementById('bug-severity').value;
  const description = document.getElementById('bug-description').value;
  const steps = document.getElementById('bug-steps').value;

  if (!title.trim() || !description.trim()) {
    alert('Please fill in at least the title and description of the bug.');
    return;
  }

  console.log('Reportando bug:', { title, severity, description, steps });

  try {
    // Faz requisição autenticada para criar defect
    const response = await makeAuthenticatedRequest('/defects', 'POST', {
      title: title,
      description: description,
      severity: severity,
      priority: 'p2', // Padrão
      status: 'open',
      reproducibility: 'always', // Padrão
      platform: {
        os: navigator.platform,
        browser: navigator.userAgent.split(' ').pop(),
        url: window.location.href
      },
      attachments: [], // TODO: Implementar anexos
      sessions: [], // TODO: Implementar sessões
      relations: []
    });

    if (response.success) {
      alert('Bug reported successfully!');
      // Limpa campos
      document.getElementById('bug-title').value = '';
      document.getElementById('bug-description').value = '';
      document.getElementById('bug-steps').value = '';
    } else {
      alert('Error reporting bug: ' + (response.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Erro ao reportar bug:', error);
    alert('Error reporting bug. Check your connection.');
  }
}

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
  }
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
        data: data
      },
      (response) => {
        resolve(response || { error: 'No response' });
      }
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
                    `
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
              `
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
        `
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
      attachments: []
    };

    await window.testPlanningService.createTestCase(
      testPlanningContext.testPlan.id,
      moduleSlug,
      suiteSlug,
      testCaseData
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
      description: description.trim()
    };

    await window.testPlanningService.createSuite(
      testPlanningContext.testPlan.id,
      moduleSlug,
      suiteData
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
      severity: severity
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
      attachments: []
    };

    await window.testPlanningService.createTestCase(
      testPlanningContext.testPlan.id,
      moduleSlug,
      suiteSlug,
      testCaseData
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

// Inicializa quando o DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVoidrExtension);
} else {
  initVoidrExtension();
}
