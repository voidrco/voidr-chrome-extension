// Recording helpers (popup)
function buildPopupRecordingContext() {
  const recordingMode =
    typeof currentView !== 'undefined' && currentView === 'defects' ? 'defect' : 'test-case';
  const timestamp = new Date().toISOString();
  const defaultName =
    recordingMode === 'defect' ? `Sample Defect ${timestamp}` : `Sample Test Case ${timestamp}`;
  const tcName =
    formState.newItemName && String(formState.newItemName).trim()
      ? formState.newItemName
      : defaultName;
  let slug = undefined;
  if (recordingMode === 'test-case') {
    try {
      slug =
        formState.isEditingExistingCase && formState.editingTestCaseData?.testCase?.slug
          ? formState.editingTestCaseData.testCase.slug
          : undefined;
    } catch (_) {}
  } else if (recordingMode === 'defect') {
    try {
      if (typeof getCurrentDefectSlug === 'function') {
        slug = getCurrentDefectSlug();
      }
    } catch (_) {}
  }
  return { recordingMode, tcName, slug };
}

// Main Extension Interface - Popup as Primary Interface

// Global state
let currentView = 'welcome';
let testPlanningContext = null;
let authStatus = null;

// UI State Management - Replicating TestPlanRecorder
let uiState = {
  // Expansão de elementos
  expandedModule: null,
  expandedSuite: null,

  // Estados de adição/edição
  isAddingModule: false,
  isAddingSuite: false,
  isAddingCase: false,

  // Contexto de qual módulo/suite está sendo usado
  selectedModuleForSuite: null,
  selectedModuleForCase: null,
  selectedSuiteForCase: null,
  // Realce pós-criação
  highlightModuleId: null,
  highlightSuiteId: null,
  // Simple router state
  route: 'modules', // 'modules' | 'suites' | 'cases'
  selectedModuleKey: null,
  selectedSuiteKey: null,
};

// Form State Management - Replicating useEditingState
let formState = {
  // Form data
  newItemName: '',
  newItemDescription: '',
  selectedSeverity: 'MEDIUM',

  // Test case specific
  newTestCase: {
    objective: '',
    prerequisites: [''],
    expectedResult: '',
    attachments: [],
    uploadedFiles: [],
  },

  // Editing states
  isEditingExistingCase: false,
  isEditingModule: false,
  isEditingSuite: false,
  editingModuleData: null,
  editingSuiteData: null,
  editingTestCaseData: null,
};

// Helper functions for state management
function updateUiState(updates) {
  uiState = { ...uiState, ...updates };
}

function updateFormState(updates) {
  formState = { ...formState, ...updates };
}

// Helper: find module by any key (id/_id/slug)
function findModuleByKey(key) {
  if (!testPlanningContext || !testPlanningContext.content) return null;
  const modules = testPlanningContext.content.modules || [];
  const keyStr = key != null ? String(key) : '';
  return (
    modules.find((m) => {
      const idStr = m.id != null ? String(m.id) : '';
      const oidStr = m._id != null ? String(m._id) : '';
      const slugStr = m.slug != null ? String(m.slug) : '';
      return idStr === keyStr || oidStr === keyStr || slugStr === keyStr;
    }) || null
  );
}

// Helper: stable DOM key for module/suite (prefer slug)
function getDomKey(item) {
  if (!item) return '';
  return String(item.slug || item.id || item._id || '');
}

// Helper: find suite by any key (id/_id/slug) within a module
function findSuiteByKey(module, key) {
  if (!module || !module.suites) return null;
  const suites = module.suites || [];
  const keyStr = key != null ? String(key) : '';
  return (
    suites.find((s) => {
      const idStr = s.id != null ? String(s.id) : '';
      const oidStr = s._id != null ? String(s._id) : '';
      const slugStr = s.slug != null ? String(s.slug) : '';
      return idStr === keyStr || oidStr === keyStr || slugStr === keyStr;
    }) || null
  );
}

function resetAddingStates() {
  updateUiState({
    isAddingModule: false,
    isAddingSuite: false,
    isAddingCase: false,
    selectedModuleForSuite: null,
    selectedModuleForCase: null,
    selectedSuiteForCase: null,
  });
}

function resetFormState() {
  updateFormState({
    newItemName: '',
    newItemDescription: '',
    selectedSeverity: 'MEDIUM',
    newTestCase: {
      objective: '',
      prerequisites: [''],
      expectedResult: '',
      attachments: [],
    },
    isEditingExistingCase: false,
    isEditingModule: false,
    isEditingSuite: false,
    editingModuleData: null,
    editingSuiteData: null,
    editingTestCaseData: null,
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Voidr Extension main interface loaded');

  // Setup global event delegation
  setupEventDelegation();

  // Sync button in header
  try {
    document.getElementById('sync-all-btn')?.addEventListener('click', async () => {
      await handleSyncAll();
    });
  } catch (_) {}

  // Listen session started to store sessionId for later PATCH
  chrome.runtime.onMessage.addListener((request) => {
    if (request && request.action === 'voidr:sessionStarted') {
      try {
        updateFormState({ lastSessionId: request.sessionId || null });
        showNotification('Recording started', 'success', 1800);
      } catch (_) {}
    } else if (request && request.action === 'voidr:sessionStopped') {
      try {
        // Visual feedback on the button
        const tcBtn = document.querySelector('[data-action="start-session-recording"]');
        if (tcBtn) {
          const original = tcBtn.innerHTML;
          tcBtn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20,6 9,17 4,12"/></svg> Session captured';
          setTimeout(() => (tcBtn.innerHTML = original), 2000);
        }
        // Defects form feedback
        const dfBtn = document.getElementById('pdf-rec');
        if (dfBtn) {
          const original = dfBtn.innerHTML;
          dfBtn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20,6 9,17 4,12"/></svg> Session captured';
          setTimeout(() => (dfBtn.innerHTML = original), 2000);
        }

        // If editing an existing case, fetch details to reflect sessionId
        if (formState.isEditingExistingCase && formState.editingTestCaseData?.testCase?.slug) {
          const module = findModuleByKey(uiState.selectedModuleKey);
          const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
          if (module && suite && module.slug && suite.slug) {
            (async () => {
              try {
                const details = await window.testPlanningService.getTestCase(
                  testPlanningContext.testPlan.id,
                  module.slug,
                  suite.slug,
                  formState.editingTestCaseData.testCase.slug,
                );
                updateFormState({ editingTestCaseData: { testCase: details } });
                // Re-render edit view to show associated session
                renderEditTestCaseView();
              } catch (_) {}
            })();
          }
        } else if (uiState.isAddingCase) {
          // If we are on the create test case form, re-render to show the captured session card
          updateTestPlanningContent();
        }
      } catch (_) {}
    } else if (request && request.action === 'voidr:sessionCaptured') {
      // Background fetched sessionId on stop; store and reflect UI immediately
      try {
        if (request.sessionId) {
          updateFormState({ lastSessionId: request.sessionId });
          // Also reflect in defects draft if open
          try {
            popupDraft.sessionId = request.sessionId;
          } catch (_) {}
          if (formState.isEditingExistingCase) {
            renderEditTestCaseView();
          } else if (uiState.isAddingCase) {
            updateTestPlanningContent();
          } else if (currentView === 'defects') {
            updateDefectSessionUI();
          }
        }
      } catch (_) {}
    }
  });

  // Initialize the extension
  // Force fresh data on popup load by clearing cache first
  try {
    if (window.testPlanningService) {
      window.testPlanningService.clearCache();
    }
  } catch (_) {}
  // Ensure initial skeleton is visible before async work
  try {
    const mc = document.getElementById('main-extension-content');
    if (mc && !mc.firstElementChild) {
      const skel = document.createElement('div');
      skel.id = 'initial-skeleton';
      skel.className = 'voidr-skeleton-container';
      skel.setAttribute('aria-hidden', 'true');
      skel.innerHTML = `<div class="voidr-skeleton"></div>`;
      mc.appendChild(skel);
    }
  } catch (_) {}
  await initializeExtension();
});

// Setup event delegation for dynamic content
function setupEventDelegation() {
  document.addEventListener('click', (event) => {
    // Handle any actionable element with data-action (divs, buttons, etc.)
    const actionable = event.target.closest('[data-action]');
    if (actionable) {
      const action = actionable.getAttribute('data-action');
      const moduleId = actionable.getAttribute('data-module-id');
      const suiteId = actionable.getAttribute('data-suite-id');
      const caseId = actionable.getAttribute('data-case-id');
      const fileIndex = actionable.getAttribute('data-file-index');
      const planAction = actionable.getAttribute('data-plan-action');
      handleAction(action, { moduleId, suiteId, caseId, fileIndex, planAction });
      event.preventDefault();
      return;
    }

    // Fallback: specific button IDs
    const target = event.target.closest('button');
    if (!target) return;

    switch (target.id) {
      case 'login-to-voidr-btn':
        console.log('Login button clicked');
        event.preventDefault();
        event.stopPropagation();
        openPlatformForAuth();
        break;
      case 'plan-tests-btn':
        console.log('Plan tests button clicked');
        navigateToTestPlanning();
        break;
      case 'report-defects-btn':
        console.log('Analyze defects button clicked');
        navigateToDefects();
        break;
      case 'back-to-welcome-btn':
        console.log('Back to welcome button clicked');
        navigateToWelcome();
        break;
      default:
        // Handle onclick attributes as fallback
        const onclickAttr = target.getAttribute('onclick');
        if (onclickAttr) {
          console.log('Executing onclick:', onclickAttr);
          try {
            eval(onclickAttr);
          } catch (error) {
            console.error('Error executing onclick:', error);
          }
        }
    }
  });
}

// Handle data-action clicks - Replicating TestPlanRecorder logic
function handleAction(action, data) {
  switch (action) {
    // Router navigation
    case 'nav-modules':
      updateUiState({ route: 'modules', selectedModuleKey: null, selectedSuiteKey: null });
      updateTestPlanningContent();
      break;
    case 'nav-suites':
      if (!data.moduleId) return;
      updateUiState({
        route: 'suites',
        selectedModuleKey: String(data.moduleId),
        selectedSuiteKey: null,
      });
      updateTestPlanningContent();
      break;
    case 'nav-cases':
      if (!data.moduleId || !data.suiteId) return;
      updateUiState({
        route: 'cases',
        selectedModuleKey: String(data.moduleId),
        selectedSuiteKey: String(data.suiteId),
      });
      updateTestPlanningContent();
      break;
    case 'create-test-plan':
      resetFormState();
      updateUiState({ isCreatingTestPlan: true });
      showCreateTestPlanForm();
      updateTestPlanningContent();
      break;
    case 'toggle-module':
      // Re-route to suites list for this module
      handleAction('nav-suites', { moduleId: data.moduleId });
      break;

    case 'toggle-suite':
      // Re-route to cases list for this suite
      handleAction('nav-cases', { moduleId: data.moduleId, suiteId: data.suiteId });
      break;

    case 'add-module':
      // Start adding module - show form
      resetFormState();
      updateUiState({ isAddingModule: true });
      showModuleForm();
      updateTestPlanningContent(); // Re-render to show form
      break;

    case 'add-suite':
      // Start adding suite - need module context
      if (!data.moduleId) {
        console.error('No module ID provided for add-suite');
        return;
      }
      resetFormState();
      updateUiState({
        isAddingSuite: true,
        selectedModuleForSuite: data.moduleId,
        expandedModule: data.moduleId, // Keep for consistency, though route drives view
      });
      showSuiteForm();
      updateTestPlanningContent(); // Re-render to show form
      break;

    case 'add-case':
      // Start adding test case - need module and suite context
      if (!data.moduleId || !data.suiteId) {
        console.error('Missing module or suite ID for add-case');
        return;
      }
      resetFormState();
      updateUiState({
        isAddingCase: true,
        selectedModuleForCase: String(data.moduleId),
        selectedSuiteForCase: String(data.suiteId),
        expandedModule: data.moduleId,
        expandedSuite: data.suiteId,
      });
      showTestCaseForm();
      updateTestPlanningContent(); // Re-render to show form
      break;

    case 'edit-case':
      // Edit existing test case: open editor view
      if (!data.caseId) return;
      startEditTestCase(data.caseId);
      break;

    case 'cancel-form':
      // Cancel any form and return to main view
      resetFormState();
      resetAddingStates();
      updateUiState({ isCreatingTestPlan: false });
      updateTestPlanningContent(); // Re-render to show main view
      break;

    case 'submit-module':
      handleSubmitModule();
      break;

    case 'submit-suite':
      handleSubmitSuite();
      break;

    case 'submit-test-case':
      handleSubmitTestCase();
      break;

    case 'submit-test-plan':
      handleSubmitTestPlan();
      break;

    case 'save-test-case':
      handleSaveEditedTestCase();
      break;

    case 'remove-uploaded-file':
      handleRemoveUploadedFile(parseInt(data.fileIndex, 10));
      break;

    case 'download-uploaded-file':
      handleDownloadUploadedFile(parseInt(data.fileIndex, 10));
      break;

    case 'start-session-recording':
      handleStartSessionRecording();
      break;
  }
}

// Toggle module accordion
function toggleModule(moduleId) {
  const moduleContent = document.getElementById(`module-content-${moduleId}`);
  // Scope chevron lookup within this module item to avoid matching other modules
  const moduleItem = document.querySelector(`.voidr-module-item[data-module-id="${moduleId}"]`);
  const chevron = moduleItem ? moduleItem.querySelector('.voidr-chevron') : null;

  if (moduleContent && chevron) {
    const isExpanded = moduleContent.style.display !== 'none';

    moduleContent.style.display = isExpanded ? 'none' : 'block';
    chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';

    // Close all suites when collapsing module
    if (isExpanded) {
      const suiteContents = moduleContent.querySelectorAll('[id^="suite-content-"]');
      suiteContents.forEach((suite) => {
        suite.style.display = 'none';
      });
      const suiteChevrons = moduleContent.querySelectorAll('.voidr-suite-header .voidr-chevron');
      suiteChevrons.forEach((chevron) => {
        chevron.style.transform = 'rotate(0deg)';
      });
    } else if (uiState.highlightSuiteId) {
      // When expanding due to recent creation, auto-open the highlighted suite
      const suiteContentId = `suite-content-${moduleId}-${uiState.highlightSuiteId}`;
      const suiteContent = document.getElementById(suiteContentId);
      const moduleItem = document.querySelector(`.voidr-module-item[data-module-id="${moduleId}"]`);
      const suiteItem = moduleItem
        ? moduleItem.querySelector(`.voidr-suite-item[data-suite-id="${uiState.highlightSuiteId}"]`)
        : null;
      const suiteChevron = suiteItem ? suiteItem.querySelector('.voidr-chevron') : null;
      if (suiteContent && suiteChevron) {
        suiteContent.style.display = 'block';
        suiteChevron.style.transform = 'rotate(90deg)';
      }
    }
  }
}

// Toggle suite accordion
function toggleSuite(moduleId, suiteId) {
  const suiteContent = document.getElementById(`suite-content-${moduleId}-${suiteId}`);
  // Scope chevron within this suite item under the specific module
  const moduleItem = document.querySelector(`.voidr-module-item[data-module-id="${moduleId}"]`);
  const suiteItem = moduleItem
    ? moduleItem.querySelector(`.voidr-suite-item[data-suite-id="${suiteId}"]`)
    : null;
  const chevron = suiteItem ? suiteItem.querySelector('.voidr-chevron') : null;

  if (suiteContent && chevron) {
    const isExpanded = suiteContent.style.display !== 'none';

    suiteContent.style.display = isExpanded ? 'none' : 'block';
    chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
  }
}

// Initialize extension
async function initializeExtension() {
  try {
    console.log('Initializing extension...');

    // Check if main content div exists
    const contentDiv = document.getElementById('main-extension-content');
    console.log('Main content div exists:', !!contentDiv);

    if (!contentDiv) {
      console.error('Main content div not found!');
      return;
    }

    // Check authentication first
    authStatus = await getAuthStatus();
    console.log('Auth status:', authStatus);

    if (!authStatus.isAuthenticated) {
      console.log('User not authenticated, showing auth required');
      showAuthenticationRequired();
      return;
    }

    console.log('User authenticated, initializing main interface');

    // Initialize test planning context
    await initializeTestPlanningContext();

    // Show welcome screen
    showWelcomeScreen();

    // Extension initialized successfully
  } catch (error) {
    showAuthenticationRequired();
  }
}

// Initialize test planning context
async function initializeTestPlanningContext() {
  try {
    // Wait for test planning service to load
    let attempts = 0;
    while (!window.testPlanningService && attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!window.testPlanningService) {
      testPlanningContext = { hasApplication: false, error: 'Service not loaded' };
      return;
    }

    // Get current tab URL or fallback to lastActiveContentUrl for floating window
    let currentUrl = await getCurrentTabUrl();
    if (!currentUrl) {
      try {
        const stored = await chrome.storage.local.get(['lastActiveContentUrl']);
        currentUrl = stored.lastActiveContentUrl || null;
      } catch (_) {}
    }

    if (!currentUrl) {
      testPlanningContext = { hasApplication: false, error: 'No URL available' };
      return;
    }

    // Initialize for current page
    testPlanningContext = await window.testPlanningService.initializeForCurrentPage(currentUrl);
  } catch (error) {
    testPlanningContext = { hasApplication: false, error: error.message };
  }
}

// Get current tab URL
function getCurrentTabUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.url || null);
    });
  });
}

// Get authentication status
function getAuthStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getAuthStatus' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting auth status:', chrome.runtime.lastError);
        resolve({ isAuthenticated: false });
        return;
      }

      resolve(response || { isAuthenticated: false });
    });
  });
}

// Show welcome screen
function showWelcomeScreen() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  // Remove initial skeleton if present
  try {
    const sk = document.getElementById('initial-skeleton');
    if (sk) sk.remove();
  } catch (_) {}

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
          <button class="voidr-action-card" id="plan-tests-btn">
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
          
          <button class="voidr-action-card" id="report-defects-btn">
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

  // Render organization card above the welcome section
  try {
    renderOrganizationCard();
  } catch (_) {}
}

// Renders organization info card (logo + name) above welcome section
async function renderOrganizationCard() {
  const container = document.getElementById('voidr-org-card');
  if (!container) return;
  try {
    const cfg = await makeAuthenticatedRequest('/customer-configs', 'GET');
    const me = await makeAuthenticatedRequest('/auth/me', 'GET');
    const data = me?.data?.data || {};
    const org = (data && (data.organization || {})) || {};
    const configData = cfg?.data?.data || {};
    const appName = Array.isArray(configData)
      ? configData[0]?.name || ''
      : configData?.name || configData?.data?.name || '';
    const orgNameCandidate =
      org.display_name || org.name || data.teamName || data.name || data.email || '';
    const orgName = orgNameCandidate || appName || 'Unknown Organization';

    container.innerHTML = `
      <div class="voidr-org-card">
        <div class="voidr-org-logo">
          <img src="${data?.logoUrl}" alt="${orgName} logo" loading="lazy" decoding="async" />
        </div>
        <div class="voidr-org-info">
          <span class="voidr-org-name">${escapeHtml(orgName || configData?.name || '')}</span>
        </div>
      </div>
    `;
  } catch (e) {
    // Silent fail: do not block welcome on errors
    container.innerHTML = `
      <div class="voidr-org-card">
        <div class="voidr-org-logo"><div class="voidr-org-logo-fallback" aria-hidden="true"></div></div>
        <div class="voidr-org-info"><span class="voidr-org-name">Unknown Organization</span></div>
      </div>
    `;
  }
}

// Navigation functions
window.navigateToTestPlanning = function () {
  currentView = 'test-planning';
  showTestPlanningView();
};

window.navigateToDefects = function () {
  currentView = 'defects';
  showDefectsView();
};

window.navigateToWelcome = function () {
  currentView = 'welcome';
  showWelcomeScreen();
};

// Show test planning view
function showTestPlanningView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  try {
    const sk = document.getElementById('initial-skeleton');
    if (sk) sk.remove();
  } catch (_) {}

  contentDiv.innerHTML = `
    <div class="voidr-view-container">
      <div class="voidr-view-header">
        <button id="back-to-welcome-btn" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h3>Test Planning</h3>
      </div>
      <div class="voidr-view-content" id="test-planning-content">
        <!-- Will be populated by updateTestPlanningContent() -->
      </div>
    </div>
  `;

  // Load test planning content (start at modules)
  if (!uiState.route) {
    updateUiState({ route: 'modules' });
  }
  updateTestPlanningContent();
}

// Show bug report view
function showDefectsView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;
  try {
    const sk = document.getElementById('initial-skeleton');
    if (sk) sk.remove();
  } catch (_) {}

  contentDiv.innerHTML = `
    <div class="voidr-view-container">
      <div class="voidr-view-header">
        <button id="back-to-welcome-btn" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h3>Analyze Defects</h3>
      </div>
      <div class="voidr-view-content" id="defects-content"></div>
    </div>
  `;

  updateDefectsListInPopup();
}

// Defects list state for popup
let popupDefects = { items: [], page: 1, limit: 20 };

async function ensureDefectsServiceLoaded() {
  if (window.defectsService && typeof window.defectsService.listDefects === 'function') return true;
  // Wait briefly for script tag execution
  let attempts = 0;
  while (
    (!window.defectsService || typeof window.defectsService.listDefects !== 'function') &&
    attempts < 30
  ) {
    await new Promise((r) => setTimeout(r, 100));
    attempts += 1;
  }
  if (!window.defectsService || typeof window.defectsService.listDefects !== 'function') {
    throw new Error('Defects service not available in popup context');
  }
  return true;
}

async function updateDefectsListInPopup() {
  const container = document.getElementById('defects-content');
  if (!container) return;
  container.innerHTML = `
    <div class="voidr-app-context">
      <div class="voidr-app-info">
        <h4>${testPlanningContext?.application?.name || 'Application'}</h4>
        <p>${testPlanningContext?.application?.environment?.name || ''}</p>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="voidr-button-primary voidr-small" id="defects-report">Report Defect</button>
      </div>
    </div>
    <div id="defects-list"></div>
  `;

  try {
    document
      .getElementById('defects-report')
      ?.addEventListener('click', () => showNewDefectFormInPopup());
    const filters = {
      page: popupDefects.page,
      limit: popupDefects.limit,
      sortBy: 'createdAt',
      sortDir: 'desc',
    };
    if (testPlanningContext?.application?.id || testPlanningContext?.application?._id) {
      filters.applicationId =
        testPlanningContext.application.id || testPlanningContext.application._id;
    }
    await ensureDefectsServiceLoaded();
    const res = await window.defectsService.listDefects(filters);
    popupDefects.items = Array.isArray(res?.items) ? res.items : [];
    renderDefectsListInPopup();
  } catch (e) {
    try {
      console.error('[Popup] Failed to load defects:', e);
    } catch (_) {}
    const list = document.getElementById('defects-list');
    if (list)
      list.innerHTML = `<div class=\"voidr-empty-state\"><h4>Failed to load defects</h4><p>${
        e?.message || 'Unknown error'
      }</p></div>`;
  }
}

function renderDefectsListInPopup() {
  const list = document.getElementById('defects-list');
  if (!list) return;
  const items = popupDefects.items || [];
  if (!items.length) {
    list.innerHTML = `<div class=\"voidr-empty-state\"><h4>No defects</h4><p>Use \"Report Defect\" to create a new one.</p></div>`;
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
      <div class=\"voidr-defect-item\" ${slug ? `data-slug=\"${slug}\"` : ''}>
        <div class=\"voidr-defect-main\">
          <div class=\"voidr-defect-title\">${title}</div>
          <div class=\"voidr-defect-meta\">
            <span class=\"voidr-status-badge voidr-status-${status}\">${status}</span>
            <span class=\"voidr-severity-badge voidr-severity-${sev}\">${sev}</span>
            <span class=\"voidr-priority-badge\">${pri}</span>
            ${slug ? `<span class=\"voidr-slug\">${slug}</span>` : ''}
          </div>
        </div>
      </div>
    `;
    })
    .join('');
  list.innerHTML = `<div class=\"voidr-defects-list\">${rows}</div>`;
  try {
    const containerEl = list.querySelector('.voidr-defects-list');
    if (containerEl) {
      containerEl.querySelectorAll('.voidr-defect-item').forEach((el) => {
        const s =
          el.getAttribute('data-slug') || el.querySelector('.voidr-slug')?.textContent?.trim();
        if (s) {
          el.style.cursor = 'pointer';
          el.addEventListener('click', () => {
            showDefectDetailInPopup(s);
          });
        }
      });
    }
  } catch (_) {}
}

function showNewDefectFormInPopup() {
  const container = document.getElementById('defects-content');
  if (!container) return;
  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button id="back-to-defects" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15,18 9,12 15,6"/></svg>
        </button>
        <h4>Report Defect</h4>
      </div>
      <div class="voidr-app-context">
        <div class="voidr-app-info">
          <h4>${testPlanningContext?.application?.name || 'Application'}</h4>
          <p>${testPlanningContext?.application?.environment?.name || ''}</p>
        </div>
      </div>
      <form id="pdf-form">
        <div class="voidr-form-group">
          <label>Title</label>
          <input type="text" id="pdf-title" required />
        </div>
        <div class="voidr-form-group">
          <label>Description</label>
          <textarea id="pdf-description" required></textarea>
        </div>
        <div class="voidr-form-group">
          <label>Ambiente</label>
          <input id="pdf-env" type="text" value="${
            testPlanningContext?.application?.environment?.name || ''
          }" placeholder="production / staging / development" />
        </div>
        <div class="voidr-form-group">
          <label>Severidade</label>
          <select id="pdf-severity">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="voidr-form-group">
          <label>Priority</label>
          <select id="pdf-priority">
            <option value="p3">P3</option>
            <option value="p2" selected>P2</option>
            <option value="p1">P1</option>
            <option value="p0">P0</option>
          </select>
        </div>
        <div class="voidr-form-group">
          <label>Reproducibility</label>
          <select id="pdf-repro">
            <option value="always" selected>Always</option>
            <option value="sometimes">Sometimes</option>
            <option value="rarely">Rarely</option>
            <option value="intermittent">Intermittent</option>
          </select>
        </div>
        <div class="voidr-form-actions">
          <button type="submit" class="voidr-button-primary">Create</button>
          <button type="button" class="voidr-button-secondary" id="pdf-cancel">Cancel</button>
          <button type="button" class="voidr-button-ghost" data-action="start-session-recording">Record session</button>
        </div>
        ${
          popupDraft?.sessionId
            ? `
        <div class="voidr-form-group" style="margin-top:8px;">
          <div style="display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#0b0f14 0%,#070a0f 100%);border:1px solid rgba(255,255,255,0.12);padding:10px 12px;border-radius:10px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:12px;color:var(--text-primary);">Associated session</span>
              <span id="pdf-associated-session" style="font-size:11px;color:var(--text-secondary);">${popupDraft.sessionId}</span>
            </div>
          </div>
        </div>
        `
            : ''
        }
        ${
          formState.lastSessionId
            ? `
        <div class="voidr-form-group" style="margin-top:8px;">
          <div id="pdf-session-card" style="display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#0b0f14 0%,#070a0f 100%);border:1px solid rgba(255,255,255,0.12);padding:10px 12px;border-radius:10px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20,6 9,17 4,12"/>
            </svg>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:12px;color:var(--text-primary);">Captured session (pending save)</span>
              <span style="font-size:11px;color:var(--text-secondary);">${formState.lastSessionId}</span>
            </div>
          </div>
        </div>
        `
            : ''
        }
      </form>
    </div>
    <div class="voidr-form-container" style="margin-top:12px;">
      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Attachments:</label>
          <input type="file" id="testcase-files" multiple />
          <div id="upload-zone" class="voidr-upload-zone">Drag & drop files here or click above</div>
        </div>
        ${
          (formState.newTestCase?.uploadedFiles || []).length > 0
            ? `<div class="voidr-uploaded-list">` +
              (formState.newTestCase.uploadedFiles || [])
                .map(
                  (f, idx) => `
            <div class="voidr-uploaded-item">
              <span class="voidr-uploaded-name">${f.name}</span>
              <div class="voidr-uploaded-actions">
                <button class="voidr-action-btn" data-action="download-uploaded-file" data-file-index="${idx}" title="Download file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7,10 12,15 17,10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
                <button class="voidr-action-btn" data-action="remove-uploaded-file" data-file-index="${idx}" title="Remove file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
          `,
                )
                .join('') +
              `</div>`
            : ''
        }
      </div>
    </div>
  `;

  try {
    document.getElementById('back-to-defects')?.addEventListener('click', () => showDefectsView());
    const form = document.getElementById('pdf-form');
    form?.addEventListener('submit', (e) => submitNewDefectInPopup(e));
    document.getElementById('pdf-cancel')?.addEventListener('click', () => showDefectsView());
    // Reuse shared listeners from test case form
    setupFormFieldListeners();
    setupUploadZoneListeners();
  } catch (_) {}
}

let popupDraft = { attachments: [] };

async function handlePopupFilesUpload(files) {
  for (const file of files) {
    try {
      let tries = 0;
      while (!window.privateStorageService && tries < 30) {
        await new Promise((r) => setTimeout(r, 100));
        tries++;
      }
      const uploaded = await window.defectsService.uploadAttachment(file, { source: 'popup' });
      popupDraft.attachments.push(uploaded);
      renderPopupUploadedAttachments();
    } catch (e) {
      showNotification('Falha ao subir arquivo: ' + (e?.message || 'Erro'), 'error');
    }
  }
}

// Show defect details (prefilled form) inside popup
async function showDefectDetailInPopup(idOrSlug) {
  const container = document.getElementById('defects-content');
  if (!container) return;
  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button id="back-to-defects" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15,18 9,12 15,6"/></svg>
        </button>
        <h4>Defect Details</h4>
      </div>
      <div class="voidr-loading" id="defect-detail-loading">Loading...</div>
      <div id="defect-detail-form-wrapper" style="display:none;"></div>
    </div>
  `;

  try {
    document.getElementById('back-to-defects')?.addEventListener('click', () => showDefectsView());
  } catch (_) {}

  try {
    await ensureDefectsServiceLoaded();
    const defect = await window.defectsService.getDefect(idOrSlug);
    const wrapper = document.getElementById('defect-detail-form-wrapper');
    const loader = document.getElementById('defect-detail-loading');
    if (!wrapper) return;
    const title = defect.title || '';
    const description = defect.description || '';
    const status = (defect.status || 'open').toLowerCase();
    const severity = (defect.severity || 'medium').toLowerCase();
    const priority = (defect.priority || 'p2').toLowerCase();
    const env = defect.applicationEnvironment || '';
    const slug = defect.slug || defect._id || idOrSlug;
    wrapper.innerHTML = `
      <form id="pdf-edit-form">
        <div class="voidr-form-group">
          <label>Slug</label>
          <input type="text" id="pdf-slug" value="${slug}" readonly />
        </div>
        <div class="voidr-form-group">
          <label>Title</label>
          <input type="text" id="pdf-title" value="${title}" required />
        </div>
        <div class="voidr-form-group">
          <label>Description</label>
          <textarea id="pdf-description" required>${description}</textarea>
        </div>
        <div class="voidr-form-group">
          <label>Ambiente</label>
          <input id="pdf-env" type="text" value="${env}" placeholder="production / staging / development" />
        </div>
        <div class="voidr-form-group">
          <label>Status</label>
          <select id="pdf-status">
            ${['open', 'in_progress', 'resolved', 'closed']
              .map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`)
              .join('')}
          </select>
        </div>
        <div class="voidr-form-group">
          <label>Severidade</label>
          <select id="pdf-severity">
            ${['low', 'medium', 'high', 'critical']
              .map((s) => `<option value="${s}" ${severity === s ? 'selected' : ''}>${s}</option>`)
              .join('')}
          </select>
        </div>
        <div class="voidr-form-group">
          <label>Priority</label>
          <select id="pdf-priority">
            ${['p3', 'p2', 'p1', 'p0']
              .map(
                (s) =>
                  `<option value="${s}" ${
                    priority === s ? 'selected' : ''
                  }>${s.toUpperCase()}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="voidr-form-actions">
          <button type="submit" class="voidr-button-primary">Save</button>
          <button type="button" class="voidr-button-secondary" id="pdf-cancel">Cancel</button>
        </div>
      </form>
    `;
    if (loader) loader.style.display = 'none';
    wrapper.style.display = 'block';

    try {
      document.getElementById('pdf-cancel')?.addEventListener('click', () => showDefectsView());
    } catch (_) {}
    try {
      const form = document.getElementById('pdf-edit-form');
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const updates = {
          title: document.getElementById('pdf-title').value.trim(),
          description: document.getElementById('pdf-description').value.trim(),
          applicationEnvironment: document.getElementById('pdf-env').value.trim(),
          status: document.getElementById('pdf-status').value,
          severity: document.getElementById('pdf-severity').value,
          priority: document.getElementById('pdf-priority').value,
        };
        try {
          await window.defectsService.updateDefect(slug, updates);
          showNotification('Defect updated', 'success');
          showDefectsView();
          try {
            await updateDefectsListInPopup();
          } catch (_) {}
        } catch (err) {
          showNotification(
            'Failed to update defect: ' + (err?.message || 'Unknown error'),
            'error',
          );
        }
      });
    } catch (_) {}
  } catch (e) {
    const wrapper = document.getElementById('defect-detail-form-wrapper');
    const loader = document.getElementById('defect-detail-loading');
    if (loader) loader.style.display = 'none';
    if (wrapper)
      wrapper.innerHTML = `<div class=\"voidr-empty-state\"><h4>Failed to load defect</h4><p>${
        e?.message || 'Unknown error'
      }</p></div>`;
  }
}

function renderPopupUploadedAttachments() {
  const list = document.getElementById('pdf-uploaded');
  if (!list) return;
  if (!popupDraft.attachments.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = popupDraft.attachments
    .map(
      (a, idx) => `
    <div class=\"voidr-uploaded-item\">
      <div class=\"voidr-uploaded-name\">${a.name}</div>
    </div>
  `,
    )
    .join('');
}

window.submitNewDefectInPopup = async function (event) {
  event.preventDefault();
  const title = document.getElementById('pdf-title').value.trim();
  const description = document.getElementById('pdf-description').value.trim();
  const env = document.getElementById('pdf-env').value.trim();
  const severity = document.getElementById('pdf-severity').value;
  const priority = document.getElementById('pdf-priority').value;
  const reproducibility = document.getElementById('pdf-repro').value;
  if (!title || !description) {
    showNotification('Please fill in title and description', 'error');
    return;
  }
  try {
    const app = testPlanningContext?.application || {};
    // Normalize environment to accepted enum
    const envRaw = env || (app.environment && (app.environment.type || app.environment.name)) || '';
    const envLower = String(envRaw || '').toLowerCase();
    const envNormalized = ['production', 'staging', 'development'].includes(envLower)
      ? envLower
      : envLower.startsWith('prod')
      ? 'production'
      : envLower.startsWith('stag')
      ? 'staging'
      : 'development';
    // Reporter from auth status
    const reporter =
      (authStatus &&
        authStatus.user &&
        (authStatus.user.id || authStatus.user._id || authStatus.user.email)) ||
      undefined;
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
      attachments: (formState?.newTestCase?.uploadedFiles || []).map((f) => ({
        id: f.id,
        name: f.name,
        url: f.url,
        size: f.size,
        type: f.type,
      })),
      sessions: formState?.lastSessionId ? [formState.lastSessionId] : [],
    };
    await window.defectsService.createDefect(payload);
    showNotification('Defect created', 'success');
    showDefectsView();
  } catch (e) {
    showNotification('Failed to create defect: ' + (e?.message || 'Unknown error'), 'error');
  }
};

// Show authentication required screen
function showAuthenticationRequired() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-welcome">
      <div class="voidr-welcome-header">
        <div class="voidr-welcome-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <h2>Authentication Required</h2>
        <p>To use the Testing Assistant, you need to login to the Voidr platform.</p>
      </div>
      
      <div class="voidr-welcome-actions">
        <div class="voidr-action-cards">
          <button class="voidr-action-card" id="login-to-voidr-btn">
            <div class="voidr-action-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                <polyline points="10,17 15,12 10,7"/>
                <line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
            </div>
            <div class="voidr-action-content">
              <h4>Login to Voidr</h4>
              <p>Opens the Voidr platform for authentication</p>
            </div>
            <div class="voidr-action-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </div>
          </button>
        </div>
      </div>
    </div>
  `;
}

// Open platform for authentication
window.openPlatformForAuth = function () {
  console.log('openPlatformForAuth called');

  // Show loading state
  const contentDiv = document.getElementById('main-extension-content');
  console.log('Content div found:', !!contentDiv);

  if (contentDiv) {
    contentDiv.innerHTML = `
      <div class="voidr-welcome">
        <div class="voidr-welcome-header">
          <div class="voidr-welcome-icon">
            <div class="loading-spinner"></div>
          </div>
          <h2>Opening Voidr Platform</h2>
          <p>Please complete your login in the new tab and return here.</p>
        </div>
        
        <div class="voidr-welcome-actions">
          <div class="voidr-action-cards">
            <button class="voidr-action-card" onclick="checkAuthenticationStatus()">
              <div class="voidr-action-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="1,4 1,10 7,10"/>
                  <polyline points="23,20 23,14 17,14"/>
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                </svg>
              </div>
              <div class="voidr-action-content">
                <h4>Check Authentication</h4>
                <p>Click here after completing login</p>
              </div>
              <div class="voidr-action-arrow">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9,18 15,12 9,6"/>
                </svg>
              </div>
            </button>
          </div>
        </div>
        
        <div class="voidr-context-info">
          <div class="voidr-context-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Keep this extension open while logging in</span>
          </div>
        </div>
      </div>
    `;
  }

  // Open platform without closing popup
  chrome.runtime.sendMessage({ action: 'openPlatformForAuth' }, (response) => {
    if (chrome.runtime.lastError) {
      showNotification('Error opening platform', 'error');
    }
  });

  // Start checking for authentication every 2 seconds
  const authCheckInterval = setInterval(async () => {
    const newAuthStatus = await getAuthStatus();
    if (newAuthStatus.isAuthenticated) {
      clearInterval(authCheckInterval);
      await initializeExtension();
    }
  }, 2000);

  // Stop checking after 5 minutes
  setTimeout(() => {
    clearInterval(authCheckInterval);
  }, 5 * 60 * 1000);
};

// Check authentication status manually
window.checkAuthenticationStatus = async function () {
  const newAuthStatus = await getAuthStatus();
  if (newAuthStatus.isAuthenticated) {
    await initializeExtension();
  } else {
    // Show feedback
    const contentDiv = document.getElementById('main-extension-content');
    if (contentDiv) {
      const currentContent = contentDiv.innerHTML;
      contentDiv.innerHTML = currentContent.replace(
        'Click here after completing login',
        'Still not authenticated - please complete login first',
      );

      // Revert after 3 seconds
      setTimeout(() => {
        if (contentDiv.innerHTML.includes('Still not authenticated')) {
          contentDiv.innerHTML = currentContent;
        }
      }, 3000);
    }
  }
};

// Update test planning content - Conditional rendering like TestPlanRecorder
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
      </div>
      ${
        uiState.isCreatingTestPlan
          ? ''
          : `
      <div class="voidr-empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
          <path d="M8.5 2h7"/>
          <path d="M7 16h10"/>
        </svg>
        <h4>No Test Plan Found</h4>
        <p>Create a test plan for this application to start testing.</p>
        <button class="voidr-button-primary" data-action="create-test-plan">Create Test Plan</button>
      </div>
      `
      }
    `;
    if (uiState.isCreatingTestPlan) {
      renderCreateTestPlanForm(contentDiv);
    }
    return;
  }

  // Router-based rendering
  if (uiState.isAddingCase) {
    renderTestCaseForm(contentDiv);
  } else if (uiState.isAddingModule) {
    renderModuleForm(contentDiv);
  } else if (uiState.isAddingSuite) {
    renderSuiteForm(contentDiv);
  } else if (uiState.isCreatingTestPlan) {
    renderCreateTestPlanForm(contentDiv);
  } else if (uiState.route === 'modules') {
    renderModulesList(contentDiv);
  } else if (uiState.route === 'suites') {
    renderSuitesList(contentDiv);
  } else if (uiState.route === 'cases') {
    renderCasesList(contentDiv);
  }
}

// Render nested accordions (replicating TestPlanRecorder)
function renderNestedAccordions(container) {
  if (!testPlanningContext || !testPlanningContext.content) {
    container.innerHTML = `
      <div class="voidr-empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
          <path d="M8.5 2h7"/>
          <path d="M7 16h10"/>
        </svg>
        <h4>No Test Plan Content</h4>
        <p>Unable to load test plan data</p>
      </div>
    `;
    return;
  }

  const { testPlan, content, application } = testPlanningContext;

  container.innerHTML = `
    <div class="voidr-test-planning">
      <!-- Header with application info -->
      <div class="voidr-app-context">
        <div class="voidr-app-info">
          <h4>📱 ${application.name}</h4>
          <p>${testPlan.name} (${content.modules ? content.modules.length : 0} modules)</p>
        </div>
        
      </div>
      
      <!-- Nested Accordions -->
      <div class="voidr-modules-accordion">
        ${
          content.modules && content.modules.length > 0
            ? content.modules
                .map(
                  (module) => `
          <div class="voidr-module-item" data-module-id="${getDomKey(module)}">
            <!-- Module Header -->
            <div class="voidr-module-header" data-action="toggle-module" data-module-id="${getDomKey(
              module,
            )}">
              <div class="voidr-accordion-toggle">
                <svg class="voidr-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9,18 15,12 9,6"/>
                </svg>
                <div class="voidr-module-info">
                  <span class="voidr-module-name">${module.name}</span>
                  <span class="voidr-severity voidr-severity-${module.severity.toLowerCase()}">${
                    module.severity
                  }</span>
                </div>
              </div>
              <div class="voidr-module-actions">
                <span class="voidr-module-count">${
                  module.suites ? module.suites.length : 0
                } suites</span>
                <button class="voidr-action-btn" data-action="add-suite" data-module-id="${
                  module.id || module._id || module.slug
                }" title="Add Suite">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </button>
              </div>
            </div>
            
            <!-- Module Content (Suites) -->
            <div class="voidr-module-content" id="module-content-${getDomKey(
              module,
            )}" style="display: none;">
              ${
                module.suites && module.suites.length > 0
                  ? module.suites
                      .map(
                        (suite) => `
                <div class="voidr-suite-item" data-suite-id="${getDomKey(suite)}">
                  <!-- Suite Header -->
                  <div class="voidr-suite-header" data-action="toggle-suite" data-module-id="${getDomKey(
                    module,
                  )}" data-suite-id="${getDomKey(suite)}">
                    <div class="voidr-accordion-toggle">
                      <svg class="voidr-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9,18 15,12 9,6"/>
                      </svg>
                      <span class="voidr-suite-name">${suite.name}</span>
                    </div>
                    <div class="voidr-suite-actions">
                      <span class="voidr-suite-count">${
                        suite.cases ? suite.cases.length : 0
                      } cases</span>
                      <button class="voidr-action-btn" data-action="add-case" data-module-id="${getDomKey(
                        module,
                      )}" data-suite-id="${getDomKey(suite)}" title="Add Test Case">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="12" y1="5" x2="12" y2="19"/>
                          <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                  
                  <!-- Suite Content (Test Cases) -->
                  <div class="voidr-suite-content" id="suite-content-${getDomKey(
                    module,
                  )}-${getDomKey(suite)}" style="display: none;">
                    ${
                      suite.cases && suite.cases.length > 0
                        ? suite.cases
                            .map(
                              (testCase) => `
                      <div class="voidr-test-case-item" data-case-id="${testCase.slug}">
                        <div class="voidr-test-case-header">
                          <div class="voidr-test-case-info">
                            <span class="voidr-test-case-name">${testCase.name}</span>
                            <p class="voidr-test-case-objective">${
                              testCase.objective || 'No objective defined'
                            }</p>
                            ${
                              testCase.sessionId
                                ? `
                            <div class="voidr-test-case-session" title="Associated session">
                              <span class="voidr-badge voidr-badge-session">Session: ${testCase.sessionId}</span>
                            </div>`
                                : ''
                            }
                          </div>
                          <div class="voidr-test-case-actions">
                            <button class="voidr-action-btn" data-action="edit-case" data-case-id="${
                              testCase.slug
                            }" title="Edit Test Case">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    `,
                            )
                            .join('')
                        : `
                      <div class="voidr-empty-suite">
                        <p>No test cases yet</p>
                      </div>
                    `
                    }
                  </div>
                </div>
              `,
                      )
                      .join('')
                  : `
                <div class="voidr-empty-module">
                  <p>No suites yet</p>
                  <button class="voidr-button-secondary voidr-small" data-action="add-suite" data-module-id="${
                    module.id || module._id || module.slug
                  }">
                    Add First Suite
                  </button>
                </div>
              `
              }
            </div>
          </div>
        `,
                )
                .join('')
            : `
          <div class="voidr-empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/>
              <path d="M8.5 2h7"/>
              <path d="M7 16h10"/>
            </svg>
            <h4>No Modules Found</h4>
            <p>Start by creating your first module</p>
            <button class="voidr-button-primary" data-action="add-module">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add Module
            </button>
          </div>
        `
        }
      </div>
      
      <!-- Add Module Button (always visible when modules exist) -->
      ${
        content.modules.length > 0
          ? `
        <div class="voidr-add-section">
          <button class="voidr-button-secondary" data-action="add-module">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Module
          </button>
        </div>
      `
          : ''
      }
    </div>
  `;
}

// Form rendering functions - Replicating TestPlanRecorder forms
function showModuleForm() {
  // Will trigger renderModuleForm via updateTestPlanningContent
  console.log('Showing module form');
}

function showSuiteForm() {
  // Will trigger renderSuiteForm via updateTestPlanningContent
  console.log('Showing suite form');
}

function showTestCaseForm() {
  // Will trigger renderTestCaseForm via updateTestPlanningContent
  console.log('Showing test case form');
}

function showCreateTestPlanForm() {
  console.log('Showing create test plan form');
}

function renderModuleForm(container) {
  const isEditing = formState.isEditingModule;

  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button class="voidr-back-button" data-action="cancel-form">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h4>${isEditing ? 'Edit' : 'New'} Module</h4>
      </div>
      
      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Module Name:</label>
          <input type="text" id="module-name" placeholder="Enter module name..." value="${
            formState.newItemName
          }" required>
        </div>
        
        <div class="voidr-form-group">
          <label>Description:</label>
          <textarea id="module-description" placeholder="Describe this module..." rows="3">${
            formState.newItemDescription
          }</textarea>
        </div>
        
        <div class="voidr-form-group">
          <label>Severity:</label>
          <select id="module-severity" required>
            <option value="LOW" ${
              formState.selectedSeverity === 'LOW' ? 'selected' : ''
            }>Low</option>
            <option value="MEDIUM" ${
              formState.selectedSeverity === 'MEDIUM' ? 'selected' : ''
            }>Medium</option>
            <option value="HIGH" ${
              formState.selectedSeverity === 'HIGH' ? 'selected' : ''
            }>High</option>
            <option value="CRITICAL" ${
              formState.selectedSeverity === 'CRITICAL' ? 'selected' : ''
            }>Critical</option>
          </select>
        </div>
        
        <div class="voidr-form-actions">
          <button class="voidr-button-primary" data-action="submit-module">${
            isEditing ? 'Update' : 'Create'
          } Module</button>
          <button class="voidr-button-secondary" data-action="cancel-form">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Setup form field listeners
  setupFormFieldListeners();
  setupUploadZoneListeners();
}

function renderSuiteForm(container) {
  const isEditing = formState.isEditingSuite;

  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button class="voidr-back-button" data-action="cancel-form">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h4>${isEditing ? 'Edit' : 'New'} Suite</h4>
      </div>
      
      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Suite Name:</label>
          <input type="text" id="suite-name" placeholder="Enter suite name..." value="${
            formState.newItemName
          }" required>
        </div>
        
        <div class="voidr-form-group">
          <label>Description:</label>
          <textarea id="suite-description" placeholder="Describe this test suite..." rows="3">${
            formState.newItemDescription
          }</textarea>
        </div>
        
        <div class="voidr-form-actions">
          <button class="voidr-button-primary" data-action="submit-suite">${
            isEditing ? 'Update' : 'Create'
          } Suite</button>
          <button class="voidr-button-secondary" data-action="cancel-form">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Setup form field listeners
  setupFormFieldListeners();
}

function renderTestCaseForm(container) {
  const isEditing = formState.isEditingExistingCase;

  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button class="voidr-back-button" data-action="cancel-form">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h4>${isEditing ? 'Edit' : 'New'} Test Case</h4>
      </div>
      
      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Test Case Name:</label>
          <input type="text" id="testcase-name" placeholder="Enter test case name..." value="${
            formState.newItemName
          }" required>
        </div>
        
        <div class="voidr-form-group">
          <label>Objective:</label>
          <textarea id="testcase-objective" placeholder="What should this test verify?" rows="3">${
            formState.newTestCase.objective
          }</textarea>
        </div>
        
        <div class="voidr-form-group">
          <label>Prerequisites:</label>
          <textarea id="testcase-prerequisites" placeholder="What needs to be set up before this test?" rows="2">${formState.newTestCase.prerequisites.join(
            '\\n',
          )}</textarea>
        </div>
        
        <div class="voidr-form-group">
          <label>Expected Result:</label>
          <textarea id="testcase-expected" placeholder="What should happen when the test passes?" rows="3">${
            formState.newTestCase.expectedResult
          }</textarea>
        </div>
        
        <div class="voidr-form-actions">
          <button class="voidr-button-primary" data-action="submit-test-case">${
            isEditing ? 'Update' : 'Create'
          } Test Case</button>
          <button class="voidr-button-secondary" data-action="cancel-form">Cancel</button>
          <button class="voidr-button-ghost" data-action="start-session-recording">Record session</button>
        </div>
        ${
          formState.lastSessionId
            ? `
        <div class="voidr-form-group" style="margin-top:8px;">
          <div id="pdf-session-card" style="display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#0b0f14 0%,#070a0f 100%);border:1px solid rgba(255,255,255,0.12);padding:10px 12px;border-radius:10px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20,6 9,17 4,12"/>
            </svg>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:12px;color:var(--text-primary);">Captured session (pending save)</span>
              <span style="font-size:11px;color:var(--text-secondary);">${formState.lastSessionId}</span>
            </div>
          </div>
        </div>
        `
            : ''
        }
      </div>
    </div>
    <div class="voidr-form-container" style="margin-top:12px;">
      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Attachments:</label>
          <input type="file" id="testcase-files" multiple />
          <div id="upload-zone" class="voidr-upload-zone">Drag & drop files here or click above</div>
        </div>
        ${
          (formState.newTestCase.uploadedFiles || []).length > 0
            ? `<div class="voidr-uploaded-list">` +
              (formState.newTestCase.uploadedFiles || [])
                .map(
                  (f, idx) => `
            <div class="voidr-uploaded-item">
              <span class="voidr-uploaded-name">${f.name}</span>
              <div class="voidr-uploaded-actions">
                <button class="voidr-action-btn" data-action="download-uploaded-file" data-file-index="${idx}" title="Download file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7,10 12,15 17,10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
                <button class="voidr-action-btn" data-action="remove-uploaded-file" data-file-index="${idx}" title="Remove file">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
          `,
                )
                .join('') +
              `</div>`
            : ''
        }
      </div>
    </div>
  `;

  // Setup form field listeners
  setupFormFieldListeners();
}

function renderModulesList(container) {
  const { content, application, testPlan } = testPlanningContext;
  container.innerHTML = `
    <div class="voidr-test-planning">
      <div class="voidr-app-context">
        <div class="voidr-app-info">
          <h4>📱 ${application.name}</h4>
          <p>${testPlan.name} (${content.modules ? content.modules.length : 0} modules)</p>
        </div>
      </div>
      <div class="voidr-modules-accordion">
        ${
          content.modules && content.modules.length
            ? content.modules
                .map(
                  (module) => `
          <div class="voidr-module-item">
            <div class="voidr-module-header" data-action="nav-suites" data-module-id="${getDomKey(
              module,
            )}">
              <div class="voidr-accordion-toggle">
                <svg class="voidr-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9,18 15,12 9,6"/>
                </svg>
                <div class="voidr-module-info">
                  <span class="voidr-module-name">${module.name}</span>
                  <span class="voidr-severity voidr-severity-${module.severity.toLowerCase()}">${
                    module.severity
                  }</span>
                </div>
              </div>
              <div class="voidr-module-actions">
                <span class="voidr-module-count">${
                  module.suites ? module.suites.length : 0
                } suites</span>
                <button class="voidr-action-btn" data-action="nav-suites" data-module-id="${getDomKey(
                  module,
                )}" title="Open Suites">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9,18 15,12 9,6"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `,
                )
                .join('')
            : `
          <div class="voidr-empty-state">
            <h4>No Modules Found</h4>
            <p>Start by creating your first module</p>
            <button class="voidr-button-primary" data-action="add-module">Add Module</button>
          </div>
        `
        }
      </div>
      ${
        content.modules && content.modules.length
          ? `
        <div class="voidr-add-section">
          <button class="voidr-button-secondary" data-action="add-module">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Module
          </button>
        </div>
      `
          : ''
      }
    </div>
  `;
}

function renderSuitesList(container) {
  const module = findModuleByKey(uiState.selectedModuleKey);
  if (!module) {
    container.innerHTML = `<div class="voidr-empty-state"><p>Module not found</p></div>`;
    return;
  }
  container.innerHTML = `
    <div class="voidr-test-planning">
      <div class="voidr-app-context">
        <button class="voidr-button-secondary voidr-small" data-action="nav-modules">Back</button>
        <div class="voidr-app-info">
          <h4>📦 ${module.name}</h4>
          <p>${module.suites ? module.suites.length : 0} suites</p>
        </div>
        <button class="voidr-button-secondary voidr-small" data-action="add-suite" data-module-id="${getDomKey(
          module,
        )}">Add Suite</button>
      </div>
      <div class="voidr-modules-accordion">
        ${
          module.suites && module.suites.length
            ? module.suites
                .map(
                  (suite) => `
          <div class="voidr-suite-item" data-suite-id="${getDomKey(suite)}">
            <div class="voidr-suite-header" data-action="nav-cases" data-module-id="${getDomKey(
              module,
            )}" data-suite-id="${getDomKey(suite)}">
              <div class="voidr-accordion-toggle">
                <svg class="voidr-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9,18 15,12 9,6"/>
                </svg>
                <span class="voidr-suite-name">${suite.name}</span>
              </div>
              <div class="voidr-suite-actions">
                <span class="voidr-suite-count">${suite.cases ? suite.cases.length : 0} cases</span>
                <button class="voidr-action-btn" data-action="nav-cases" data-module-id="${getDomKey(
                  module,
                )}" data-suite-id="${getDomKey(suite)}" title="Open Cases">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9,18 15,12 9,6"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `,
                )
                .join('')
            : `
          <div class="voidr-empty-state">
            <p>No suites yet</p>
            <button class="voidr-button-secondary voidr-small" data-action="add-suite" data-module-id="${getDomKey(
              module,
            )}">Add First Suite</button>
          </div>
        `
        }
      </div>
    </div>
  `;
}

function renderCasesList(container) {
  const module = findModuleByKey(uiState.selectedModuleKey);
  const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
  if (!module || !suite) {
    container.innerHTML = `<div class="voidr-empty-state"><p>Suite not found</p></div>`;
    return;
  }
  const cases = Array.isArray(suite.cases) ? suite.cases : null;
  if (!cases) {
    // Lazy-load cases before rendering list
    container.innerHTML = `
      <div class="voidr-loading-state">
        <div class="voidr-loading-spinner"></div>
        <p>Loading test cases...</p>
      </div>
    `;
    (async () => {
      try {
        const fetched = await window.testPlanningService.getSuiteCases(
          testPlanningContext.testPlan.id,
          module.slug,
          suite.slug,
        );
        suite.cases = fetched || [];
        // Also refresh details for the selected case if we're returning from edit
        if (formState.editingTestCaseData?.testCase?.slug) {
          const refreshed = await window.testPlanningService.getTestCase(
            testPlanningContext.testPlan.id,
            module.slug,
            suite.slug,
            formState.editingTestCaseData.testCase.slug,
          );
          // Replace in list if found
          const idx = suite.cases.findIndex((c) => c.slug === refreshed.slug);
          if (idx >= 0) suite.cases[idx] = refreshed;
        }
      } catch (_) {
        suite.cases = [];
      }
      renderCasesList(container);
    })();
    return;
  }
  container.innerHTML = `
    <div class="voidr-test-planning">
      <div class="voidr-app-context">
        <button class="voidr-button-secondary voidr-small" data-action="nav-suites" data-module-id="${getDomKey(
          module,
        )}">Back</button>
        <div class="voidr-app-info">
          <h4>🧪 ${suite.name}</h4>
          <p>${cases.length} cases</p>
        </div>
        <button class="voidr-button-secondary voidr-small" data-action="add-case" data-module-id="${getDomKey(
          module,
        )}" data-suite-id="${getDomKey(suite)}">Add Case</button>
      </div>
      <div class="voidr-module-content">
        ${
          cases.length
            ? cases
                .map(
                  (testCase) => `
          <div class="voidr-test-case-item" data-action="edit-case" data-case-id="${testCase.slug}">
            <div class="voidr-test-case-header">
              <div class="voidr-test-case-info">
                <span class="voidr-test-case-name">${testCase.name}</span>
                <p class="voidr-test-case-objective">${
                  testCase.objective || 'No objective defined'
                }</p>
                ${
                  testCase.sessionId
                    ? `
                <div class="voidr-test-case-session" title="Associated session">
                  <span class="voidr-badge voidr-badge-session">Session: ${testCase.sessionId}</span>
                </div>`
                    : ''
                }
              </div>
              <div class="voidr-test-case-actions">
                <button class="voidr-action-btn" data-action="edit-case" data-case-id="${
                  testCase.slug
                }" title="Edit Test Case">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `,
                )
                .join('')
            : `
          <div class="voidr-empty-suite"><p>No test cases yet</p></div>
        `
        }
      </div>
    </div>
  `;
}

async function startEditTestCase(testCaseSlug) {
  try {
    const module = findModuleByKey(uiState.selectedModuleKey);
    const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
    if (!module || !suite || !module.slug || !suite.slug) {
      showNotification('Context not available for editing', 'error');
      return;
    }
    showLoadingState('Loading test case...');
    const details = await window.testPlanningService.getTestCase(
      testPlanningContext.testPlan.id,
      module.slug,
      suite.slug,
      testCaseSlug,
    );
    hideLoadingState();
    updateFormState({
      newItemName: details.name || '',
      newItemDescription: '',
      newTestCase: {
        objective: details.objective || '',
        prerequisites: Array.isArray(details.prerequisites) ? details.prerequisites : [],
        expectedResult: details.expectedResult || '',
        attachments: details.attachments || [],
        uploadedFiles: (details.attachments || []).map((att) => ({
          id: att.id || att.slug || `${att.name}_${att.url}`,
          name: att.name,
          url: att.url,
          size: att.size || 0,
          type: att.type || 'application/octet-stream',
          storage: { key: att.url, fileName: att.name, contentType: att.type, size: att.size },
        })),
      },
      isEditingExistingCase: true,
      editingTestCaseData: {
        testCase: details,
      },
    });
    renderEditTestCaseView();
  } catch (error) {
    hideLoadingState();
    showNotification(`Error: ${error.message}`, 'error');
  }
}

function renderEditTestCaseView() {
  const container = document.getElementById('test-planning-content');
  if (!container) return;
  const module = findModuleByKey(uiState.selectedModuleKey);
  const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button class="voidr-back-button" data-action="nav-cases" data-module-id="${getDomKey(
          module,
        )}" data-suite-id="${getDomKey(suite)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h4>Edit Test Case</h4>
      </div>
      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Test Case Name:</label>
          <input type="text" id="testcase-name" value="${
            formState.newItemName
          }" placeholder="Enter test case name..." required>
        </div>
        <div class="voidr-form-group">
          <label>Objective:</label>
          <textarea id="testcase-objective" rows="3">${formState.newTestCase.objective}</textarea>
        </div>
        <div class="voidr-form-group">
          <label>Prerequisites:</label>
          <textarea id="testcase-prerequisites" rows="2">${(
            formState.newTestCase.prerequisites || []
          ).join('\n')}</textarea>
        </div>
        <div class="voidr-form-group">
          <label>Expected Result:</label>
          <textarea id="testcase-expected" rows="3">${
            formState.newTestCase.expectedResult
          }</textarea>
        </div>
        <div class="voidr-form-actions" style="margin-top:8px;">
          <button class="voidr-button-secondary" data-action="start-session-recording">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="6"/></svg>
            Record session
          </button>
        </div>
        ${
          formState.editingTestCaseData?.testCase?.sessionId
            ? `
        <div class="voidr-form-group" style="margin-top:8px;">
          <div style="display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#0b0f14 0%,#070a0f 100%);border:1px solid rgba(255,255,255,0.12);padding:10px 12px;border-radius:10px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:12px;color:var(--text-primary);">Associated session</span>
              <span style="font-size:11px;color:var(--text-secondary);">${formState.editingTestCaseData.testCase.sessionId}</span>
            </div>
          </div>
        </div>
        `
            : ''
        }
        ${
          formState.lastSessionId
            ? `
        <div class="voidr-form-group" style="margin-top:8px;">
          <div id="pdf-session-card" style="display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#0b0f14 0%,#070a0f 100%);border:1px solid rgba(255,255,255,0.12);padding:10px 12px;border-radius:10px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20,6 9,17 4,12"/>
            </svg>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:12px;color:var(--text-primary);">Captured session (pending save)</span>
              <span style="font-size:11px;color:var(--text-secondary);">${formState.lastSessionId}</span>
            </div>
          </div>
        </div>
        `
            : ''
        }
        <div class="voidr-form-group">
          <label>Attachments:</label>
          <input type="file" id="testcase-files" multiple />
          <div id="upload-zone" class="voidr-upload-zone">Drag & drop files here or click above</div>
        </div>
        ${
          (formState.newTestCase.uploadedFiles || []).length > 0
            ? `<div class="voidr-uploaded-list">` +
              (formState.newTestCase.uploadedFiles || [])
                .map(
                  (f, idx) => `
            <div class=\"voidr-uploaded-item\"> 
              <span class=\"voidr-uploaded-name\">${f.name}</span>
              <div class=\"voidr-uploaded-actions\"> 
                <button class=\"voidr-action-btn\" data-action=\"download-uploaded-file\" data-file-index=\"${idx}\" title=\"Download file\"> 
                  <svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"> 
                    <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> 
                    <polyline points=\"7,10 12,15 17,10\"/> 
                    <line x1=\"12\" y1=\"15\" x2=\"12\" y2=\"3\"/> 
                  </svg> 
                </button> 
                <button class=\"voidr-action-btn\" data-action=\"remove-uploaded-file\" data-file-index=\"${idx}\" title=\"Remove file\"> 
                  <svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"> 
                    <line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/> 
                    <line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/> 
                  </svg> 
                </button> 
              </div>
            </div>
          `,
                )
                .join('') +
              `</div>`
            : ''
        }
        <div class="voidr-form-actions">
          <button class="voidr-button-primary" data-action="save-test-case">Save Changes</button>
          <button class="voidr-button-secondary" data-action="nav-cases" data-module-id="${getDomKey(
            module,
          )}" data-suite-id="${getDomKey(suite)}">Cancel</button>
        </div>
      </div>
    </div>
  `;
  setupFormFieldListeners();
  setupUploadZoneListeners();
}

function renderCreateTestPlanForm(container) {
  const selectedStatus = formState.planStatus || 'DRAFT';
  container.innerHTML = `
    <div class="voidr-form-container">
      <div class="voidr-form-header">
        <button class="voidr-back-button" data-action="cancel-form">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
        </button>
        <h4>New Test Plan</h4>
      </div>

      <div class="voidr-form-content">
        <div class="voidr-form-group">
          <label>Plan Name:</label>
          <input type="text" id="plan-name" placeholder="Enter plan name..." value="${
            formState.newItemName
          }" required>
        </div>

        <div class="voidr-form-group">
          <label>Description:</label>
          <textarea id="plan-description" placeholder="Describe this test plan..." rows="3">${
            formState.newItemDescription
          }</textarea>
        </div>

        <div class="voidr-form-group">
          <label>Status:</label>
          <select id="plan-status">
            <option value="DRAFT" ${selectedStatus === 'DRAFT' ? 'selected' : ''}>Draft</option>
            <option value="ACTIVE" ${selectedStatus === 'ACTIVE' ? 'selected' : ''}>Active</option>
          </select>
        </div>

        <div class="voidr-form-actions">
          <button class="voidr-button-primary" data-action="submit-test-plan">Create Plan</button>
          <button class="voidr-button-secondary" data-action="cancel-form">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Setup listeners
  const nameEl = document.getElementById('plan-name');
  const descEl = document.getElementById('plan-description');
  const statusEl = document.getElementById('plan-status');
  if (nameEl)
    nameEl.addEventListener('input', (e) => updateFormState({ newItemName: e.target.value }));
  if (descEl)
    descEl.addEventListener('input', (e) =>
      updateFormState({ newItemDescription: e.target.value }),
    );
  if (statusEl)
    statusEl.addEventListener('change', (e) => updateFormState({ planStatus: e.target.value }));
}

// Setup form field listeners to update state
function setupFormFieldListeners() {
  // Module form fields
  const moduleNameEl = document.getElementById('module-name');
  const moduleDescEl = document.getElementById('module-description');
  const moduleSeverityEl = document.getElementById('module-severity');

  if (moduleNameEl) {
    moduleNameEl.addEventListener('input', (e) => {
      updateFormState({ newItemName: e.target.value });
    });
  }

  if (moduleDescEl) {
    moduleDescEl.addEventListener('input', (e) => {
      updateFormState({ newItemDescription: e.target.value });
    });
  }

  if (moduleSeverityEl) {
    moduleSeverityEl.addEventListener('change', (e) => {
      updateFormState({ selectedSeverity: e.target.value });
    });
  }

  // Suite form fields
  const suiteNameEl = document.getElementById('suite-name');
  const suiteDescEl = document.getElementById('suite-description');

  if (suiteNameEl) {
    suiteNameEl.addEventListener('input', (e) => {
      updateFormState({ newItemName: e.target.value });
    });
  }

  if (suiteDescEl) {
    suiteDescEl.addEventListener('input', (e) => {
      updateFormState({ newItemDescription: e.target.value });
    });
  }

  // Test case form fields
  const tcNameEl = document.getElementById('testcase-name');
  const tcObjectiveEl = document.getElementById('testcase-objective');
  const tcPrereqEl = document.getElementById('testcase-prerequisites');
  const tcExpectedEl = document.getElementById('testcase-expected');
  const fileInputEl = document.getElementById('testcase-files');

  if (tcNameEl) {
    tcNameEl.addEventListener('input', (e) => {
      updateFormState({ newItemName: e.target.value });
    });
  }

  if (tcObjectiveEl) {
    tcObjectiveEl.addEventListener('input', (e) => {
      updateFormState({
        newTestCase: { ...formState.newTestCase, objective: e.target.value },
      });
    });
  }

  if (tcPrereqEl) {
    tcPrereqEl.addEventListener('input', (e) => {
      const prerequisites = e.target.value.split('\\n').filter((p) => p.trim());
      updateFormState({
        newTestCase: { ...formState.newTestCase, prerequisites },
      });
    });
  }

  if (tcExpectedEl) {
    tcExpectedEl.addEventListener('input', (e) => {
      updateFormState({
        newTestCase: { ...formState.newTestCase, expectedResult: e.target.value },
      });
    });
  }

  if (fileInputEl) {
    fileInputEl.addEventListener('change', async (e) => {
      const input = e.target;
      const files = input && input.files ? input.files : null;
      if (!files || files.length === 0) return;
      const uploaded = [...(formState.newTestCase.uploadedFiles || [])];
      const existingKeys = new Set(
        uploaded.map((f) => (typeof f.url === 'string' ? f.url : String(f.url))),
      );
      showLoadingState('Uploading files...');
      try {
        const { folder, metadata } = computeUploadContext();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          // Prefer direct flow to background to avoid timing issues
          const res = await uploadFileFlow(file, folder, metadata);
          if (existingKeys.has(res.key)) {
            continue; // skip duplicates by storage key
          }
          existingKeys.add(res.key);
          uploaded.push({
            id: crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${i}`,
            name: res.fileName,
            url: res.key,
            size: res.size,
            type: res.contentType,
            storage: res,
          });
        }
        // Dedupe safety by url
        const dedup = [];
        const seen = new Set();
        for (const f of uploaded) {
          const key = typeof f.url === 'string' ? f.url : String(f.url);
          if (!seen.has(key)) {
            seen.add(key);
            dedup.push(f);
          }
        }
        updateFormState({ newTestCase: { ...formState.newTestCase, uploadedFiles: dedup } });
        // If editing an existing test case, patch attachments immediately and refresh
        if (
          formState.isEditingExistingCase &&
          uiState.selectedModuleKey &&
          uiState.selectedSuiteKey &&
          formState.editingTestCaseData &&
          formState.editingTestCaseData.testCase &&
          formState.editingTestCaseData.testCase.slug
        ) {
          const module = findModuleByKey(uiState.selectedModuleKey);
          const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
          if (module && suite && module.slug && suite.slug) {
            const combined = [
              ...(formState.newTestCase.attachments || []),
              ...uploaded.map((f) => ({
                id: f.id,
                name: f.name,
                url: f.url,
                size: f.size,
                type: f.type,
              })),
            ];
            // Dedupe by url for PATCH
            const mapByUrl = new Map();
            for (const a of combined) {
              if (!mapByUrl.has(a.url)) mapByUrl.set(a.url, a);
            }
            const newAttachments = Array.from(mapByUrl.values());
            await window.testPlanningService.updateTestCase(
              testPlanningContext.testPlan.id,
              module.slug,
              suite.slug,
              formState.editingTestCaseData.testCase.slug,
              { attachments: newAttachments },
            );
            // Fetch canonical details and re-render editor with backend data
            const details = await window.testPlanningService.getTestCase(
              testPlanningContext.testPlan.id,
              module.slug,
              suite.slug,
              formState.editingTestCaseData.testCase.slug,
            );
            // Map back from canonical details, dedup by url
            const attach = details.attachments || [];
            const seenUrls = new Set();
            const uploadedFiles = [];
            for (const att of attach) {
              const url = att.url;
              if (seenUrls.has(url)) continue;
              seenUrls.add(url);
              uploadedFiles.push({
                id: att.id || att.slug || `${att.name}_${att.url}`,
                name: att.name,
                url: att.url,
                size: att.size || 0,
                type: att.type || 'application/octet-stream',
                storage: {
                  key: att.url,
                  fileName: att.name,
                  contentType: att.type,
                  size: att.size,
                },
              });
            }
            updateFormState({
              newTestCase: {
                ...formState.newTestCase,
                objective: details.objective || '',
                prerequisites: Array.isArray(details.prerequisites) ? details.prerequisites : [],
                expectedResult: details.expectedResult || '',
                attachments: attach,
                uploadedFiles,
              },
            });
            renderEditTestCaseView();
          }
        }
        showNotification('Files uploaded successfully', 'success');
      } catch (err) {
        const msg = err && err.message ? err.message : 'Failed to upload files';
        showNotification(msg, 'error');
      } finally {
        hideLoadingState();
        if (input) input.value = '';
      }
    });
  }
}

// Setup drag & drop listeners for upload zone
function setupUploadZoneListeners() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('testcase-files');
  if (!zone || !input) return;

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('voidr-upload-over');
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('voidr-upload-over');
  };
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('voidr-upload-over');
    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;
    // Pass dropped files to the same handler as input change
    const dataTransfer = new DataTransfer();
    Array.from(dt.files).forEach((f) => dataTransfer.items.add(f));
    input.files = dataTransfer.files;
    const event = new Event('change');
    input.dispatchEvent(event);
  };

  zone.addEventListener('dragover', onDragOver);
  zone.addEventListener('dragleave', onDragLeave);
  zone.addEventListener('drop', onDrop);
  zone.addEventListener('click', () => input.click());
}

// Ensure storage service is loaded in popup context
async function ensurePrivateStorageServiceLoaded() {
  if (window.privateStorageService && window.privateStorageService.uploadFile) {
    return true;
  }
  try {
    const existing = document.querySelector('script[data-voidr="storage-service"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('services/privateStorageService.js');
      script.async = true;
      script.defer = true;
      script.setAttribute('data-voidr', 'storage-service');
      document.head.appendChild(script);
    }
  } catch (_) {}

  // Wait up to 2 seconds for it to be available
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (window.privateStorageService && window.privateStorageService.uploadFile) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Compute folder and metadata for uploads based on current context
function computeUploadContext() {
  try {
    const planId = testPlanningContext?.testPlan?.id || null;
    // Prefer edit route keys
    let module = null;
    let suite = null;
    if (uiState.route === 'cases') {
      module = findModuleByKey(uiState.selectedModuleKey);
      suite = findSuiteByKey(module, uiState.selectedSuiteKey);
    } else {
      // Fallback to creation context
      if (uiState.selectedModuleForCase) {
        module = findModuleByKey(uiState.selectedModuleForCase);
      }
      if (module && uiState.selectedSuiteForCase) {
        suite = findSuiteByKey(module, uiState.selectedSuiteForCase);
      }
    }
    const moduleSlug = module?.slug || 'module';
    const suiteSlug = suite?.slug || 'suite';

    const folder = planId ? `test-plans_${planId}_${moduleSlug}_${suiteSlug}` : 'test-cases';
    const metadata = {
      module: 'test-plans',
      type: 'test-case',
      testPlanId: planId || undefined,
      moduleSlug: module?.slug || undefined,
      suiteSlug: suite?.slug || undefined,
      source: 'extension',
    };
    return { folder, metadata };
  } catch (_) {
    return {
      folder: 'test-cases',
      metadata: { module: 'test-plans', type: 'test-case', source: 'extension' },
    };
  }
}

// Direct upload flow via background API (presign → upload → confirm)
async function uploadFileFlow(file, folder, metadata) {
  // Step 1: presign
  const presign = await makeAuthenticatedRequest('/private-storage/upload-url', 'POST', {
    fileName: file.name,
    contentType: file.type,
    folder,
    metadata,
  });
  if (!presign?.success) throw new Error(presign?.error || 'Failed to generate upload URL');
  const { uploadUrl, fileKey } = presign.data?.data || presign.data || presign;
  if (!uploadUrl || !fileKey) throw new Error('Invalid presign response');

  // Step 2: upload to signed URL
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);

  // Step 3: confirm
  const confirm = await makeAuthenticatedRequest('/private-storage/confirm-upload', 'POST', {
    fileKey,
    fileName: file.name,
    contentType: file.type,
    size: file.size,
    metadata,
  });
  if (!confirm?.success) throw new Error(confirm?.error || 'Failed to confirm upload');
  const payload = confirm.data?.data || confirm.data || confirm;
  return {
    key: payload.key || payload.fileKey,
    fileKey: payload.key || payload.fileKey,
    fileName: payload.fileName || file.name,
    contentType: payload.contentType || file.type,
    size: payload.size || file.size,
    metadata: payload.metadata || metadata,
  };
}

// Submit handlers - Replicating TestPlanRecorder logic
async function handleSubmitModule() {
  if (!formState.newItemName.trim()) {
    showNotification('Please enter a module name', 'error');
    return;
  }

  // Show loading state
  showLoadingState('Creating module...');

  try {
    if (!window.testPlanningService) {
      throw new Error('Service not available');
    }

    if (!testPlanningContext || !testPlanningContext.testPlan) {
      throw new Error('No test plan available');
    }

    if (formState.isEditingModule && formState.editingModuleData) {
      // Update existing module
      await window.testPlanningService.updateModule(
        testPlanningContext.testPlan.id,
        formState.editingModuleData.slug,
        {
          name: formState.newItemName,
          description: formState.newItemDescription,
          severity: formState.selectedSeverity,
        },
      );
      showNotification('Module updated successfully', 'success');
    } else {
      // Create new module
      const moduleData = {
        name: formState.newItemName,
        description: formState.newItemDescription,
        severity: formState.selectedSeverity,
      };

      const newModule = await window.testPlanningService.createModule(
        testPlanningContext.testPlan.id,
        moduleData,
      );

      // Expand the newly created module
      if (newModule && (newModule.id || newModule._id)) {
        updateUiState({ expandedModule: newModule.id || newModule._id });
      } else if (newModule && newModule.data && (newModule.data.id || newModule.data._id)) {
        updateUiState({ expandedModule: newModule.data.id || newModule.data._id });
      }

      showNotification('Module created successfully', 'success');
    }

    // Reset states and refresh
    resetFormState();
    resetAddingStates();
    await refreshTestPlanningAndShow();
  } catch (error) {
    const message = error?.message || 'Unknown error';
    showNotification(`Error creating module: ${message}`, 'error');
  } finally {
    hideLoadingState();
  }
}

async function handleSubmitSuite() {
  if (!formState.newItemName.trim()) {
    showNotification('Please enter a suite name', 'error');
    return;
  }

  // Determine module context
  const moduleKey = uiState.selectedModuleForSuite || uiState.expandedModule;
  if (!moduleKey) {
    showNotification('Select a module first', 'error');
    return;
  }

  const module = findModuleByKey(moduleKey);
  if (!module || !module.slug) {
    showNotification('Module not found or invalid', 'error');
    return;
  }

  showLoadingState(formState.isEditingSuite ? 'Updating suite...' : 'Creating suite...');

  try {
    const testPlanId = testPlanningContext.testPlan.id;

    if (formState.isEditingSuite && formState.editingSuiteData) {
      await window.testPlanningService.updateSuite(
        testPlanId,
        module.slug,
        formState.editingSuiteData.suite.slug,
        {
          name: formState.newItemName,
          description: formState.newItemDescription,
        },
      );
      showNotification('Suite updated successfully', 'success');
    } else {
      const created = await window.testPlanningService.createSuite(testPlanId, module.slug, {
        name: formState.newItemName,
        description: formState.newItemDescription,
      });

      const newSuite = created?.data || created || null;
      if (newSuite) {
        module.suites = module.suites || [];
        module.suites.unshift({
          ...newSuite,
          id: newSuite.id || newSuite._id,
          cases: [],
        });
        updateUiState({
          expandedModule: moduleKey,
          expandedSuite: newSuite.id || newSuite._id,
          highlightModuleId: String(module.id || module._id || module.slug),
          highlightSuiteId: String(newSuite.id || newSuite._id || newSuite.slug),
        });
      }

      showNotification('Suite created successfully', 'success');
    }

    if (window.testPlanningService) window.testPlanningService.clearCache();
    await initializeTestPlanningContext();
    updateTestPlanningContent();

    resetFormState();
    resetAddingStates();
  } catch (error) {
    showNotification(`Error: ${error.message}`, 'error');
  } finally {
    hideLoadingState();
  }
}

async function handleSubmitTestCase() {
  if (!formState.newItemName.trim()) {
    showNotification('Please enter a test case name', 'error');
    return;
  }

  if (!uiState.selectedModuleForCase || !uiState.selectedSuiteForCase) {
    showNotification('No module or suite selected for test case', 'error');
    return;
  }

  showLoadingState('Creating test case...');

  try {
    // Find module and suite robustly (id/_id/slug)
    const module = findModuleByKey(uiState.selectedModuleForCase);
    const suite = findSuiteByKey(module, uiState.selectedSuiteForCase);

    if (!module || !suite) {
      throw new Error('Module or suite not found');
    }
    if (!module.slug || !suite.slug) {
      throw new Error('Missing module or suite slug');
    }

    const testCaseData = {
      name: formState.newItemName,
      objective: formState.newTestCase.objective,
      prerequisites: formState.newTestCase.prerequisites.filter((p) => p.trim()),
      expectedResult: formState.newTestCase.expectedResult,
    };

    if (formState.isEditingExistingCase && formState.editingTestCaseData) {
      // Update existing test case
      await window.testPlanningService.updateTestCase(
        testPlanningContext.testPlan.id,
        module.slug,
        suite.slug,
        formState.editingTestCaseData.testCase.slug,
        {
          ...testCaseData,
          // On edit, allow in-place attachment update via the separate upload flow already implemented
        },
      );
      showNotification('Test case updated successfully', 'success');
    } else {
      // Create new test case
      const created = await window.testPlanningService.createTestCase(
        testPlanningContext.testPlan.id,
        module.slug,
        suite.slug,
        {
          ...testCaseData,
          sessionId: formState.lastSessionId || undefined,
        },
      );
      // After create, if there are uploaded files, associate them via PATCH
      const pendingUploads = (formState.newTestCase.uploadedFiles || []).map((f) => ({
        id: f.id,
        name: f.name,
        url: f.url,
        size: f.size,
        type: f.type,
      }));
      if (pendingUploads.length > 0) {
        const createdSlug =
          (created && created.slug) || (created && created.data && created.data.slug) || null;
        const testCaseSlug = createdSlug || formState.editingTestCaseData?.testCase?.slug || null;
        if (testCaseSlug) {
          await window.testPlanningService.updateTestCase(
            testPlanningContext.testPlan.id,
            module.slug,
            suite.slug,
            testCaseSlug,
            {
              attachments: pendingUploads,
              sessionId: formState.lastSessionId || undefined,
            },
          );
        }
      }
      showNotification('Test case created successfully', 'success');
      // Clear captured session after successful association to avoid leaking it into other views/forms
      updateFormState({ lastSessionId: null });
    }

    // Reset states and refresh
    resetFormState();
    resetAddingStates();
    await refreshTestPlanningAndShow();
  } catch (error) {
    showNotification(`Error: ${error.message}`, 'error');
  } finally {
    hideLoadingState();
  }
}

async function handleSubmitTestPlan() {
  if (!formState.newItemName.trim()) {
    showNotification('Please enter a plan name', 'error');
    return;
  }

  try {
    showLoadingState('Creating test plan...');
    if (!window.testPlanningService) throw new Error('Service not available');
    if (!testPlanningContext?.application?.id) throw new Error('No application available');

    const created = await window.testPlanningService.createTestPlan(
      testPlanningContext.application.id,
      {
        name: formState.newItemName,
        description: formState.newItemDescription,
        status: formState.planStatus || 'DRAFT',
      },
    );

    showNotification('Test plan created successfully', 'success');

    // Refresh full context and enter planning view
    resetFormState();
    resetAddingStates();
    updateUiState({ isCreatingTestPlan: false });
    await refreshTestPlanningAndShow();
  } catch (error) {
    showNotification(`Error: ${error.message}`, 'error');
  } finally {
    hideLoadingState();
  }
}

async function handleSaveEditedTestCase() {
  try {
    const module = findModuleByKey(uiState.selectedModuleKey);
    const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
    if (
      !module ||
      !suite ||
      !module.slug ||
      !suite.slug ||
      !formState.editingTestCaseData?.testCase?.slug
    ) {
      showNotification('Context not available for saving', 'error');
      return;
    }

    // Read latest values from form inputs
    const nameEl = document.getElementById('testcase-name');
    const objectiveEl = document.getElementById('testcase-objective');
    const prereqEl = document.getElementById('testcase-prerequisites');
    const expectedEl = document.getElementById('testcase-expected');

    const updates = {
      name: nameEl?.value?.trim() || '',
      objective: objectiveEl?.value || '',
      prerequisites: (prereqEl?.value || '')
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
      expectedResult: expectedEl?.value || '',
      attachments: formState.newTestCase.attachments || [],
      // If a fresh session was captured, include it in the PATCH
      ...(formState.lastSessionId ? { sessionId: formState.lastSessionId } : {}),
    };

    if (!updates.name) {
      showNotification('Please enter a test case name', 'error');
      return;
    }

    showLoadingState('Saving changes...');
    await window.testPlanningService.updateTestCase(
      testPlanningContext.testPlan.id,
      module.slug,
      suite.slug,
      formState.editingTestCaseData.testCase.slug,
      updates,
    );
    hideLoadingState();
    showNotification('Test case updated successfully', 'success');

    // Refresh content and go back to cases list
    resetFormState();
    // Clear captured session after association to avoid displaying it on unrelated cases
    updateFormState({ lastSessionId: null });
    await refreshTestPlanningAndShow();
    handleAction('nav-cases', { moduleId: getDomKey(module), suiteId: getDomKey(suite) });
  } catch (error) {
    hideLoadingState();
    showNotification(`Error: ${error.message}`, 'error');
  }
}

async function handleRemoveUploadedFile(index) {
  const files = [...(formState.newTestCase.uploadedFiles || [])];
  if (index < 0 || index >= files.length) return;
  const file = files[index];
  try {
    showLoadingState('Removing file...');
    // If editing, patch attachments removing it
    if (
      formState.isEditingExistingCase &&
      uiState.selectedModuleKey &&
      uiState.selectedSuiteKey &&
      formState.editingTestCaseData?.testCase?.slug
    ) {
      const module = findModuleByKey(uiState.selectedModuleKey);
      const suite = findSuiteByKey(module, uiState.selectedSuiteKey);
      if (module && suite && module.slug && suite.slug) {
        const remaining = (formState.newTestCase.attachments || []).filter(
          (att) => att.url !== file.url,
        );
        await window.testPlanningService.updateTestCase(
          testPlanningContext.testPlan.id,
          module.slug,
          suite.slug,
          formState.editingTestCaseData.testCase.slug,
          { attachments: remaining },
        );
        const details = await window.testPlanningService.getTestCase(
          testPlanningContext.testPlan.id,
          module.slug,
          suite.slug,
          formState.editingTestCaseData.testCase.slug,
        );
        updateFormState({
          newTestCase: {
            ...formState.newTestCase,
            objective: details.objective || '',
            prerequisites: Array.isArray(details.prerequisites) ? details.prerequisites : [],
            expectedResult: details.expectedResult || '',
            attachments: details.attachments || [],
            uploadedFiles: (details.attachments || []).map((att) => ({
              id: att.id || att.slug || `${att.name}_${att.url}`,
              name: att.name,
              url: att.url,
              size: att.size || 0,
              type: att.type || 'application/octet-stream',
              storage: { key: att.url, fileName: att.name, contentType: att.type, size: att.size },
            })),
          },
        });
        renderEditTestCaseView();
      }
    } else {
      // Creation flow: just remove locally
      files.splice(index, 1);
      updateFormState({ newTestCase: { ...formState.newTestCase, uploadedFiles: files } });
      updateTestPlanningContent();
    }
    showNotification('File removed', 'success');
  } catch (error) {
    showNotification(`Error: ${error.message}`, 'error');
  } finally {
    hideLoadingState();
  }
}

async function handleDownloadUploadedFile(index) {
  const files = formState.newTestCase.uploadedFiles || [];
  if (index < 0 || index >= files.length) return;
  const file = files[index];
  try {
    // If storage key (non-blob), get presigned download first
    const isBlob = typeof file.url === 'string' && file.url.startsWith('blob:');
    if (!isBlob) {
      const dl = await makeAuthenticatedRequest(
        `/private-storage/presign-download?key=${encodeURIComponent(file.url)}`,
        'GET',
      );
      if (dl && dl.success) {
        const data = dl.data?.data || dl.data || dl;
        const url = data.url || null;
        if (url) {
          window.open(url, '_blank');
          return;
        }
      }
      // Fallback: open storage key directly (may 403)
      window.open(file.url, '_blank');
    } else {
      // Blob URL from local upload preview, open directly
      window.open(file.url, '_blank');
    }
  } catch (_) {
    // Fallback to direct open
    window.open(file.url, '_blank');
  }
}

async function handleStartSessionRecording() {
  try {
    const { recordingMode, tcName, slug } = buildPopupRecordingContext();
    showNotification('Starting recording...', 'info', 1200);
    chrome.runtime.sendMessage(
      {
        action: 'forwardToLastContent',
        payload: {
          action: 'voidr:startSessionRecording',
          testCaseName: tcName,
          mode: recordingMode,
          slug: slug,
        },
      },
      (response) => {
        try {
          if (!response || response.success !== true) {
            const msg = (response && response.error) || 'Open a tab with a website and try again';
            showNotification(`Could not start recording: ${msg}`, 'error', 3000);
          }
        } catch (_) {}
      },
    );
  } catch (_) {}
}

// Helper function to refresh and show test planning
async function refreshTestPlanningAndShow() {
  // Clear cache first to force fresh data
  if (window.testPlanningService) {
    window.testPlanningService.clearCache();
  }

  // Re-initialize context (fetches fresh data from API)
  await initializeTestPlanningContext();

  // Re-render the UI with fresh data
  // If we were deep-linked into suites/cases, try to preserve route if keys still exist
  const canStayOnSuites = uiState.route === 'suites' && findModuleByKey(uiState.selectedModuleKey);
  const canStayOnCases =
    uiState.route === 'cases' &&
    findModuleByKey(uiState.selectedModuleKey) &&
    findSuiteByKey(findModuleByKey(uiState.selectedModuleKey), uiState.selectedSuiteKey);
  if (!canStayOnSuites && !canStayOnCases) {
    updateUiState({ route: 'modules', selectedModuleKey: null, selectedSuiteKey: null });
  }
  updateTestPlanningContent();
}

// World-class notification system
function showNotification(message, type = 'info', duration = 3000) {
  // Remove existing notifications
  const existingNotification = document.querySelector('.voidr-notification');
  if (existingNotification) {
    existingNotification.remove();
  }

  const notification = document.createElement('div');
  notification.className = `voidr-notification voidr-notification-${type}`;

  const icon = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20,6 9,17 4,12"/></svg>`,
    error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21,8l-8-5L5,8v9a3,3,0,0,0,3,3h8a3,3,0,0,0,3-3Z"/><polyline points="10,9 14,9 14,13 10,13"/></svg>`,
    info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };

  notification.innerHTML = `
    <div class="voidr-notification-content">
      <div class="voidr-notification-icon">${icon[type]}</div>
      <span class="voidr-notification-message">${message}</span>
    </div>
  `;

  document.body.appendChild(notification);

  // Animate in
  requestAnimationFrame(() => {
    notification.style.transform = 'translateX(0)';
    notification.style.opacity = '1';
  });

  // Auto remove
  setTimeout(() => {
    notification.style.transform = 'translateX(100%)';
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, duration);
}

// Loading state management
function showLoadingState(message = 'Loading...') {
  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'voidr-loading-overlay';
  loadingOverlay.id = 'loading-overlay';

  loadingOverlay.innerHTML = `
    <div class="voidr-loading-content">
      <div class="voidr-loading-spinner"></div>
      <span class="voidr-loading-message">${message}</span>
    </div>
  `;

  document.body.appendChild(loadingOverlay);

  // Animate in
  requestAnimationFrame(() => {
    loadingOverlay.style.opacity = '1';
  });
}

function hideLoadingState() {
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) {
    loadingOverlay.style.opacity = '0';
    setTimeout(() => loadingOverlay.remove(), 200);
  }
}

// Progress indicator for forms
function showFormProgress(step, total) {
  const progressBar = document.querySelector('.voidr-form-progress');
  if (progressBar) {
    const percentage = (step / total) * 100;
    progressBar.style.setProperty('--progress', `${percentage}%`);
  }
}

function editTestCase(caseId) {
  showNotification(`Edit Test Case ${caseId} - to be implemented`, 'info');
}

// Global functions for test planning
window.refreshTestPlanningContext = async function () {
  try {
    if (window.testPlanningService) {
      window.testPlanningService.clearCache();
    }
  } catch (_) {}
  await initializeTestPlanningContext();
  if (currentView === 'test-planning') {
    showTestPlanningView();
  } else {
    showWelcomeScreen();
  }
};

// Sync all data: test planning (apps/plan/modules/suites/cases) and defects list
window.handleSyncAll = async function () {
  try {
    showNotification('Sincronizando...', 'info', 1200);
    try {
      if (window.testPlanningService) {
        window.testPlanningService.clearCache();
      }
    } catch (_) {}
    try {
      if (window.defectsService && window.defectsService.cache) {
        window.defectsService.cache.clear();
      }
    } catch (_) {}
    await initializeTestPlanningContext();
    if (currentView === 'defects') {
      await updateDefectsListInPopup();
    }
    if (currentView === 'test-planning') {
      updateTestPlanningContent();
    }
    // Update welcome context info as well
    if (currentView === 'welcome') {
      showWelcomeScreen();
    }
    showNotification('Sincronizado', 'success', 1200);
  } catch (_) {
    showNotification('Failed to sync', 'error', 2000);
  }
};

window.showQuickTestCaseForm = function () {
  showNotification('Quick test case form - to be implemented', 'info');
};

window.showFullTestPlan = function () {
  // Open full test plan in platform
  if (testPlanningContext?.testPlan) {
    const env = (typeof globalThis !== 'undefined' && globalThis.__VOIDR_ENV__) || {};
    const platformUrl = env.VOIDR_PLATFORM_URL || 'https://canary.voidr.co';
    chrome.tabs.create({
      url: `${platformUrl}/test-planning/${testPlanningContext.testPlan.id}`,
      active: true,
    });
  }
};

// Bug reporting functions
window.captureScreenshot = function () {
  chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
    if (response?.screenshot) {
      console.log('Screenshot captured:', response.screenshot.length, 'bytes');
      showNotification('Screenshot captured successfully!', 'success');
    }
  });
};

window.reportBug = async function () {
  const title = document.getElementById('bug-title')?.value;
  const severity = document.getElementById('bug-severity')?.value;
  const description = document.getElementById('bug-description')?.value;
  const steps = document.getElementById('bug-steps')?.value;

  if (!title?.trim() || !description?.trim()) {
    showNotification('Please fill in at least the title and description of the bug.', 'error');
    return;
  }

  try {
    // Make authenticated request to create defect
    const response = await makeAuthenticatedRequest('/defects', 'POST', {
      title: title,
      description: description,
      severity: severity,
      priority: 'p2',
      status: 'open',
      reproducibility: 'always',
      platform: {
        os: navigator.platform,
        browser: navigator.userAgent.split(' ').pop(),
        url: await getCurrentTabUrl(),
      },
      attachments: [],
      sessions: [],
      relations: [],
    });

    if (response.success) {
      showNotification('Bug reported successfully!', 'success');
      // Clear fields
      document.getElementById('bug-title').value = '';
      document.getElementById('bug-description').value = '';
      document.getElementById('bug-steps').value = '';

      // Return to welcome
      navigateToWelcome();
    } else {
      showNotification('Error reporting bug: ' + (response.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Error reporting bug:', error);
    showNotification('Error reporting bug. Check your connection.', 'error');
  }
};

// Make authenticated API request
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

// Small helper to escape HTML in dynamic strings
function escapeHtml(str) {
  try {
    return String(str).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]),
    );
  } catch (_) {
    return str;
  }
}

// Listen for authentication state changes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Popup received message:', request);

  if (request.action === 'authStateUpdated' && request.authData.isAuthenticated) {
    console.log('Auth state updated, refreshing interface...');
    setTimeout(() => {
      initializeExtension();
    }, 500);
  } else if (request.action === 'authExpired') {
    console.log('Auth expired, showing login screen...');
    showAuthenticationRequired();
  }
});

// Check if popup should show success state on load
window.addEventListener('focus', async () => {
  console.log('Popup gained focus, checking if auth was completed...');

  // Check if user just completed authentication
  const result = await chrome.storage.local.get(['shouldReopenExtension']);
  if (result.shouldReopenExtension) {
    console.log('User returned after authentication, checking status...');

    const newAuthStatus = await getAuthStatus();
    if (newAuthStatus.isAuthenticated) {
      console.log('Authentication confirmed, reinitializing...');
      await chrome.storage.local.remove(['shouldReopenExtension', 'reopenTimestamp']);
      await initializeExtension();
    }
  }
});

function updateDefectSessionUI() {
  try {
    const card = document.getElementById('pdf-session-card');
    const assoc = document.getElementById('pdf-associated-session');
    const sid =
      typeof formState !== 'undefined' && formState.lastSessionId ? formState.lastSessionId : '';
    if (card) {
      const container = card;
      if (sid) {
        container.style.display = 'flex';
        const lines = container.querySelectorAll('span');
        if (lines && lines[1]) lines[1].textContent = sid;
      } else {
        container.style.display = 'none';
      }
    }
    if (assoc && popupDraft?.sessionId) {
      assoc.textContent = popupDraft.sessionId;
    }
  } catch (_) {}
}
