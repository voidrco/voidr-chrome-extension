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
  selectedSuiteForCase: null
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
    attachments: []
  },

  // Editing states
  isEditingExistingCase: false,
  isEditingModule: false,
  isEditingSuite: false,
  editingModuleData: null,
  editingSuiteData: null,
  editingTestCaseData: null
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
  return modules.find((m) => m.id === key || m._id === key || m.slug === key) || null;
}

function resetAddingStates() {
  updateUiState({
    isAddingModule: false,
    isAddingSuite: false,
    isAddingCase: false,
    selectedModuleForSuite: null,
    selectedModuleForCase: null,
    selectedSuiteForCase: null
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
      attachments: []
    },
    isEditingExistingCase: false,
    isEditingModule: false,
    isEditingSuite: false,
    editingModuleData: null,
    editingSuiteData: null,
    editingTestCaseData: null
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Voidr Extension main interface loaded');

  // Setup global event delegation
  setupEventDelegation();

  // Initialize the extension
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
      handleAction(action, { moduleId, suiteId, caseId });
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
        console.log('Report defects button clicked');
        navigateToBugReport();
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
    case 'toggle-module':
      // Toggle module expansion
      (async () => {
        const newExpandedModule = uiState.expandedModule === data.moduleId ? null : data.moduleId;
        updateUiState({
          expandedModule: newExpandedModule,
          expandedSuite: null
        });

        // If expanding, ensure suites are present (already fetched in content), just open
        toggleModule(data.moduleId);
      })();
      break;

    case 'toggle-suite':
      // Toggle suite expansion
      (async () => {
        const newExpandedSuite = uiState.expandedSuite === data.suiteId ? null : data.suiteId;
        updateUiState({ expandedSuite: newExpandedSuite });

        // If expanding, fetch cases on-demand and render
        if (newExpandedSuite) {
          const module = testPlanningContext.content.modules.find(
            (m) => (m.id || m._id) === data.moduleId
          );
          const suite = module?.suites?.find((s) => (s.id || s._id) === data.suiteId);
          const moduleSlug = module?.slug;
          const suiteSlug = suite?.slug;
          const testPlanId = testPlanningContext.testPlan.id;

          if (module && suite && moduleSlug && suiteSlug) {
            const cases = await window.testPlanningService.getSuiteCases(
              testPlanId,
              moduleSlug,
              suiteSlug
            );
            suite.cases = cases;
            updateTestPlanningContent();
          }
        }

        toggleSuite(data.moduleId, data.suiteId);
      })();
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
        expandedModule: data.moduleId // Ensure module is expanded
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
        selectedModuleForCase: data.moduleId,
        selectedSuiteForCase: data.suiteId,
        expandedModule: data.moduleId,
        expandedSuite: data.suiteId
      });
      showTestCaseForm();
      updateTestPlanningContent(); // Re-render to show form
      break;

    case 'edit-case':
      // Edit existing test case
      editTestCase(data.caseId);
      break;

    case 'cancel-form':
      // Cancel any form and return to main view
      resetFormState();
      resetAddingStates();
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

// Navigation functions
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

// Show test planning view
function showTestPlanningView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;

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

  // Load test planning content
  updateTestPlanningContent();
}

// Show bug report view
function showBugReportView() {
  const contentDiv = document.getElementById('main-extension-content');
  if (!contentDiv) return;

  contentDiv.innerHTML = `
    <div class="voidr-view-container">
      <div class="voidr-view-header">
        <button id="back-to-welcome-btn" class="voidr-back-button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15,18 9,12 15,6"/>
          </svg>
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
        'Still not authenticated - please complete login first'
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
    `;
    return;
  }

  // Conditional rendering based on UI state - like TestPlanRecorder
  if (uiState.isAddingCase) {
    renderTestCaseForm(contentDiv);
  } else if (uiState.isAddingModule) {
    renderModuleForm(contentDiv);
  } else if (uiState.isAddingSuite) {
    renderSuiteForm(contentDiv);
  } else {
    // Default: render nested accordions (ModulesList equivalent)
    renderNestedAccordions(contentDiv);
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
        <button onclick="refreshTestPlanningContext()" class="voidr-button-secondary voidr-small">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="1,4 1,10 7,10"/>
            <polyline points="23,20 23,14 17,14"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
          </svg>
        </button>
      </div>
      
      <!-- Nested Accordions -->
      <div class="voidr-modules-accordion">
        ${
          content.modules && content.modules.length > 0
            ? content.modules
                .map(
                  (module) => `
          <div class="voidr-module-item" data-module-id="${module.id || module._id || module.slug}">
            <!-- Module Header -->
            <div class="voidr-module-header" data-action="toggle-module" data-module-id="${
              module.id || module._id || module.slug
            }">
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
                  module.id
                }" title="Add Suite">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </button>
              </div>
            </div>
            
            <!-- Module Content (Suites) -->
            <div class="voidr-module-content" id="module-content-${
              module.id || module._id || module.slug
            }" style="display: none;">
              ${
                module.suites && module.suites.length > 0
                  ? module.suites
                      .map(
                        (suite) => `
                <div class="voidr-suite-item" data-suite-id="${
                  suite.id || suite._id || suite.slug
                }">
                  <!-- Suite Header -->
                  <div class="voidr-suite-header" data-action="toggle-suite" data-module-id="${
                    module.id || module._id || module.slug
                  }" data-suite-id="${suite.id || suite._id || suite.slug}">
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
                      <button class="voidr-action-btn" data-action="add-case" data-module-id="${
                        module.id || module._id || module.slug
                      }" data-suite-id="${
                          suite.id || suite._id || suite.slug
                        }" title="Add Test Case">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="12" y1="5" x2="12" y2="19"/>
                          <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                  
                  <!-- Suite Content (Test Cases) -->
                  <div class="voidr-suite-content" id="suite-content-${
                    module.id || module._id || module.slug
                  }-${suite.id || suite._id || suite.slug}" style="display: none;">
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
                    `
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
              `
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
        `
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
            '\\n'
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
        </div>
      </div>
    </div>
  `;

  // Setup form field listeners
  setupFormFieldListeners();
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

  if (tcNameEl) {
    tcNameEl.addEventListener('input', (e) => {
      updateFormState({ newItemName: e.target.value });
    });
  }

  if (tcObjectiveEl) {
    tcObjectiveEl.addEventListener('input', (e) => {
      updateFormState({
        newTestCase: { ...formState.newTestCase, objective: e.target.value }
      });
    });
  }

  if (tcPrereqEl) {
    tcPrereqEl.addEventListener('input', (e) => {
      const prerequisites = e.target.value.split('\\n').filter((p) => p.trim());
      updateFormState({
        newTestCase: { ...formState.newTestCase, prerequisites }
      });
    });
  }

  if (tcExpectedEl) {
    tcExpectedEl.addEventListener('input', (e) => {
      updateFormState({
        newTestCase: { ...formState.newTestCase, expectedResult: e.target.value }
      });
    });
  }
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
          severity: formState.selectedSeverity
        }
      );
      showNotification('Module updated successfully', 'success');
    } else {
      // Create new module
      const moduleData = {
        name: formState.newItemName,
        description: formState.newItemDescription,
        severity: formState.selectedSeverity
      };

      const newModule = await window.testPlanningService.createModule(
        testPlanningContext.testPlan.id,
        moduleData
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
    showNotification(`Error: ${error.message}`, 'error');
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
          description: formState.newItemDescription
        }
      );
      showNotification('Suite updated successfully', 'success');
    } else {
      const created = await window.testPlanningService.createSuite(testPlanId, module.slug, {
        name: formState.newItemName,
        description: formState.newItemDescription
      });

      const newSuite = created?.data || created || null;
      if (newSuite) {
        module.suites = module.suites || [];
        module.suites.unshift({
          ...newSuite,
          id: newSuite.id || newSuite._id,
          cases: []
        });
        updateUiState({ expandedModule: moduleKey, expandedSuite: newSuite.id || newSuite._id });
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
    // Find module and suite to get slugs
    const module = testPlanningContext.content.modules.find(
      (m) => (m.id || m._id) === uiState.selectedModuleForCase
    );

    const suite = module?.suites?.find((s) => (s.id || s._id) === uiState.selectedSuiteForCase);

    if (!module || !module.slug || !suite || !suite.slug) {
      throw new Error('Module or suite not found or missing slug');
    }

    const testCaseData = {
      name: formState.newItemName,
      objective: formState.newTestCase.objective,
      prerequisites: formState.newTestCase.prerequisites.filter((p) => p.trim()),
      expectedResult: formState.newTestCase.expectedResult,
      attachments: formState.newTestCase.attachments
    };

    if (formState.isEditingExistingCase && formState.editingTestCaseData) {
      // Update existing test case
      await window.testPlanningService.updateTestCase(
        testPlanningContext.testPlan.id,
        module.slug,
        suite.slug,
        formState.editingTestCaseData.testCase.slug,
        testCaseData
      );
      showNotification('Test case updated successfully', 'success');
    } else {
      // Create new test case
      await window.testPlanningService.createTestCase(
        testPlanningContext.testPlan.id,
        module.slug,
        suite.slug,
        testCaseData
      );
      showNotification('Test case created successfully', 'success');
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

// Helper function to refresh and show test planning
async function refreshTestPlanningAndShow() {
  // Clear cache first to force fresh data
  if (window.testPlanningService) {
    window.testPlanningService.clearCache();
  }

  // Re-initialize context (fetches fresh data from API)
  await initializeTestPlanningContext();

  // Re-render the UI with fresh data
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
    info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
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
  alert(`Edit Test Case ${caseId} - to be implemented`);
}

// Global functions for test planning
window.refreshTestPlanningContext = async function () {
  await initializeTestPlanningContext();
  if (currentView === 'test-planning') {
    showTestPlanningView();
  } else {
    showWelcomeScreen();
  }
};

window.showQuickTestCaseForm = function () {
  alert('Quick test case form - to be implemented');
};

window.showFullTestPlan = function () {
  // Open full test plan in platform
  if (testPlanningContext?.testPlan) {
    chrome.tabs.create({
      url: `http://localhost:3030/test-planning/${testPlanningContext.testPlan.id}`,
      active: true
    });
  }
};

// Bug reporting functions
window.captureScreenshot = function () {
  chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
    if (response?.screenshot) {
      console.log('Screenshot captured:', response.screenshot.length, 'bytes');
      alert('Screenshot captured successfully!');
    }
  });
};

window.reportBug = async function () {
  const title = document.getElementById('bug-title')?.value;
  const severity = document.getElementById('bug-severity')?.value;
  const description = document.getElementById('bug-description')?.value;
  const steps = document.getElementById('bug-steps')?.value;

  if (!title?.trim() || !description?.trim()) {
    alert('Please fill in at least the title and description of the bug.');
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
        url: await getCurrentTabUrl()
      },
      attachments: [],
      sessions: [],
      relations: []
    });

    if (response.success) {
      alert('Bug reported successfully!');
      // Clear fields
      document.getElementById('bug-title').value = '';
      document.getElementById('bug-description').value = '';
      document.getElementById('bug-steps').value = '';

      // Return to welcome
      navigateToWelcome();
    } else {
      alert('Error reporting bug: ' + (response.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error reporting bug:', error);
    alert('Error reporting bug. Check your connection.');
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
        data: data
      },
      (response) => {
        resolve(response || { error: 'No response' });
      }
    );
  });
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
