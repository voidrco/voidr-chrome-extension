// Test Planning Service for Voidr Extension
// Replicates the platform's test planning functionality

if (typeof window !== 'undefined' && window.testPlanningService) {
  // Already defined – avoid double registration
} else {
  class TestPlanningService {
    constructor() {
      this.currentApplication = null;
      this.currentTestPlan = null;
      this.cache = new Map();
    }

    // Find application by URL matching environments
    async findApplicationByUrl(currentUrl) {
      try {
        console.log('Finding application for URL:', currentUrl);

        // Get all applications (usando parâmetros corretos da API)
        const appsResponse = await this.makeAPIRequest(
          '/applications?page=1&limit=100&sortBy=createdAt&sortDir=desc',
        );

        if (!appsResponse.success) {
          console.log('Applications request failed:', appsResponse.error);
          return null;
        }

        // Handle different response structures
        const applications = appsResponse.data?.data || appsResponse.data || [];

        if (!applications.length) {
          console.log('No applications found in response');
          return null;
        }
        console.log(`Found ${applications.length} applications`);
        console.log(
          'Applications structure:',
          applications.map((app) => ({
            name: app.name,
            id: app.id,
            _id: app._id,
            allKeys: Object.keys(app),
          })),
        );

        // Check each application's environments
        for (const app of applications) {
          try {
            // Handle different ID field names (_id vs id)
            const appId = app.id || app._id;

            if (!appId || appId === 'undefined') {
              console.warn(`⚠️ Skipping application with invalid ID: ${app.name}`, app);
              continue;
            }

            console.log(`🔍 Checking application: ${app.name} (${appId})`);
            const envsResponse = await this.makeAPIRequest(`/applications/${appId}/environments`);

            if (envsResponse.success) {
              // Handle different response structures for environments
              const environments = envsResponse.data?.data || envsResponse.data || [];
              console.log(
                `📋 Found ${environments.length} environments for ${app.name}:`,
                environments.map((e) => ({ name: e.name, url: e.applicationUrl })),
              );

              // Check if current URL matches any environment URL
              for (const env of environments) {
                console.log(`🔗 Checking environment: ${env.name} - ${env.applicationUrl}`);

                if (env.applicationUrl && this.urlMatches(currentUrl, env.applicationUrl)) {
                  console.log(`✅ Found matching application: ${app.name} (${appId})`);
                  console.log(`✅ Matching environment: ${env.name} - ${env.applicationUrl}`);

                  this.currentApplication = {
                    ...app,
                    id: appId, // Ensure consistent ID field
                    environment: env,
                  };

                  return this.currentApplication;
                } else {
                  console.log(`❌ No match for ${env.name}: ${env.applicationUrl}`);
                }
              }
            } else {
              console.log(`⚠️ No environments found for ${app.name}:`, envsResponse);
            }
          } catch (error) {
            console.warn(`❌ Error checking environments for app ${app.id}:`, error);
          }
        }

        console.log('No matching application found for URL');
        return null;
      } catch (error) {
        console.error('Error finding application by URL:', error);
        return null;
      }
    }

    // Create a new test plan for an application
    async createTestPlan(applicationId, planData) {
      try {
        if (!applicationId) throw new Error('Missing applicationId');

        const apiData = {
          applicationId: applicationId,
          name: planData?.name,
          description: planData?.description || '',
          status: planData?.status || 'DRAFT',
        };

        const response = await this.makeAPIRequest(`/test-plans`, 'POST', apiData);

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to create test plan');
        }

        // Invalidate any cached test plan content lists
        this.cache.clear();
        return response.data;
      } catch (error) {
        throw error;
      }
    }

    // Check if URLs match (handles different protocols, subdomains, etc.)
    urlMatches(currentUrl, envUrl) {
      try {
        // Handle empty or invalid URLs
        if (!currentUrl || !envUrl) {
          return false;
        }

        console.log('Comparing URLs:', { currentUrl, envUrl });

        // Try URL parsing first
        let current, env;
        try {
          current = new URL(currentUrl);
          env = new URL(envUrl);
        } catch (urlError) {
          console.warn('URL parsing failed, using string comparison:', urlError);
          // Fallback to simple string matching
          return currentUrl.includes(envUrl) || envUrl.includes(currentUrl);
        }

        console.log('Parsed URLs:', {
          current: { hostname: current.hostname, port: current.port, pathname: current.pathname },
          env: { hostname: env.hostname, port: env.port, pathname: env.pathname },
        });

        // 1. Exact hostname and port match
        if (current.hostname === env.hostname && current.port === env.port) {
          console.log('✅ Exact hostname and port match');
          return true;
        }

        // 2. Exact hostname match (ignore port differences)
        if (current.hostname === env.hostname) {
          console.log('✅ Exact hostname match');
          return true;
        }

        // 3. Subdomain match (e.g., app.example.com matches example.com)
        if (
          current.hostname.endsWith('.' + env.hostname) ||
          env.hostname.endsWith('.' + current.hostname)
        ) {
          console.log('✅ Subdomain match');
          return true;
        }

        // 4. Localhost variations with port matching
        const isCurrentLocalhost =
          current.hostname === 'localhost' || current.hostname === '127.0.0.1';
        const isEnvLocalhost = env.hostname === 'localhost' || env.hostname === '127.0.0.1';

        if (isCurrentLocalhost && isEnvLocalhost) {
          const portMatch = current.port === env.port;
          console.log('Localhost ports:', {
            current: current.port,
            env: env.port,
            match: portMatch,
          });
          return portMatch;
        }

        // 5. URL prefix match (current URL starts with env URL)
        if (currentUrl.startsWith(envUrl)) {
          console.log('✅ URL prefix match');
          return true;
        }

        // 6. Base URL match (env URL starts with current URL)
        if (envUrl.startsWith(currentUrl)) {
          console.log('✅ Base URL match');
          return true;
        }

        console.log('❌ No URL match found');
        return false;
      } catch (error) {
        console.warn('Error comparing URLs:', error, { currentUrl, envUrl });
        return false;
      }
    }

    // Find test plan for current application
    async findTestPlanForApplication(applicationId) {
      try {
        console.log('Finding test plan for application:', applicationId);

        const response = await this.makeAPIRequest(
          `/test-plans?applicationId=${applicationId}&page=1&limit=10&sortBy=updatedAt&sortDir=desc`,
        );

        if (!response.success) {
          console.log('Test plans request failed:', response.error);
          return null;
        }

        // Handle different response structures
        const testPlans = response.data?.data || response.data || [];

        if (!testPlans.length) {
          console.log('No test plans found for application');
          return null;
        }
        console.log(`Found ${testPlans.length} test plans`);
        console.log(
          'Test plans structure:',
          testPlans.map((plan) => ({
            name: plan.name,
            id: plan.id,
            _id: plan._id,
            status: plan.status,
            allKeys: Object.keys(plan),
          })),
        );

        // Prefer ACTIVE plans, then DRAFT
        const activePlan = testPlans.find((plan) => plan.status === 'ACTIVE');
        const draftPlan = testPlans.find((plan) => plan.status === 'DRAFT');

        const selectedPlan = activePlan || draftPlan || testPlans[0];

        // Handle different ID field names for test plans
        const planId = selectedPlan.id || selectedPlan._id;

        if (!planId || planId === 'undefined') {
          console.error('Selected test plan has invalid ID:', selectedPlan);
          return null;
        }

        console.log(`Selected test plan: ${selectedPlan.name} (${planId})`);

        // Ensure consistent ID field
        this.currentTestPlan = {
          ...selectedPlan,
          id: planId,
        };

        return this.currentTestPlan;
      } catch (error) {
        console.error('Error finding test plan:', error);
        return null;
      }
    }

    // Get complete test plan content (modules > suites > cases)
    async getTestPlanContent(testPlanId) {
      try {
        const cacheKey = `testplan_${testPlanId}`;

        // Check cache first
        if (this.cache.has(cacheKey)) {
          return this.cache.get(cacheKey);
        }

        // Validate testPlanId before making request
        if (!testPlanId || testPlanId === 'undefined') {
          throw new Error('Invalid test plan ID provided');
        }

        const planRes = await this.makeAPIRequest(`/test-plans/${testPlanId}`);

        if (!planRes.success) {
          throw new Error('Failed to fetch test plan');
        }

        // Fetch modules from dedicated endpoint (platform-compatible)
        const modulesRes = await this.makeAPIRequest(`/test-plans/${testPlanId}/modules`);
        const rawModules = modulesRes?.data?.data || modulesRes?.data || [];

        // For each module, fetch suites from dedicated endpoint
        const modulesWithSuites = await Promise.all(
          rawModules.map(async (mod) => {
            const moduleId = mod.id || mod._id;
            const moduleSlug = mod.slug;

            let suites = [];
            if (moduleSlug) {
              const suitesRes = await this.makeAPIRequest(
                `/test-plans/${testPlanId}/modules/${moduleSlug}/suites`,
              );
              suites = suitesRes?.data?.data || suitesRes?.data || [];
            }

            return {
              ...mod,
              id: moduleId,
              suites: suites || [],
            };
          }),
        );

        const content = {
          testPlan: planRes.data,
          modules: modulesWithSuites,
        };

        // Cache for 5 minutes
        this.cache.set(cacheKey, content);
        setTimeout(() => this.cache.delete(cacheKey), 5 * 60 * 1000);

        return content;
      } catch (error) {
        throw error;
      }
    }

    // Create new test case
    async createTestCase(testPlanId, moduleSlug, suiteSlug, testCaseData) {
      try {
        console.log('Creating test case:', { testPlanId, moduleSlug, suiteSlug, testCaseData });

        // Ensure required fields and proper format
        const apiData = {
          name: testCaseData.name,
          objective: testCaseData.objective || '',
          prerequisites: Array.isArray(testCaseData.prerequisites)
            ? testCaseData.prerequisites
            : testCaseData.prerequisites
            ? [testCaseData.prerequisites]
            : [],
          expectedResult: testCaseData.expectedResult || '',
          type: 'MANUAL', // Default to MANUAL for extension-created cases
          attachments: testCaseData.attachments || [],
        };
        if (Object.prototype.hasOwnProperty.call(testCaseData, 'sessionId')) {
          apiData.sessionId = testCaseData.sessionId;
        }

        const response = await this.makeAPIRequest(
          `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases`,
          'POST',
          apiData,
        );

        if (!response.success) {
          throw new Error(response.error || 'Failed to create test case');
        }

        // Clear cache to force refresh
        this.cache.delete(`testplan_${testPlanId}`);
        return response.data;
      } catch (error) {
        throw error;
      }
    }

    // Get a specific test case details
    async getTestCase(testPlanId, moduleSlug, suiteSlug, testCaseSlug) {
      try {
        const response = await this.makeAPIRequest(
          `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases/${testCaseSlug}`,
        );
        if (!response?.success) {
          throw new Error(response?.error || 'Failed to fetch test case');
        }
        const data = response?.data?.data || response?.data || response;
        return data;
      } catch (error) {
        throw error;
      }
    }

    // Update existing test case
    async updateTestCase(testPlanId, moduleSlug, suiteSlug, testCaseSlug, updates) {
      try {
        const apiData = {};
        if (Object.prototype.hasOwnProperty.call(updates, 'name')) {
          apiData.name = updates.name;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'objective')) {
          apiData.objective = updates.objective;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'prerequisites')) {
          apiData.prerequisites = Array.isArray(updates.prerequisites)
            ? updates.prerequisites
            : updates.prerequisites
            ? [updates.prerequisites]
            : [];
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'expectedResult')) {
          apiData.expectedResult = updates.expectedResult;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'type')) {
          apiData.type = updates.type;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
          apiData.status = updates.status;
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'attachments')) {
          apiData.attachments = updates.attachments || [];
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'sessionId')) {
          apiData.sessionId = updates.sessionId; // can be string or null to unlink
        }

        const response = await this.makeAPIRequest(
          `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases/${testCaseSlug}`,
          'PATCH',
          apiData,
        );

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to update test case');
        }

        this.cache.delete(`testplan_${testPlanId}`);
        return response.data;
      } catch (error) {
        throw error;
      }
    }

    // Create new module
    async createModule(testPlanId, moduleData) {
      try {
        console.log('Creating module:', { testPlanId, moduleData });

        // Ensure proper API format
        const apiData = {
          name: moduleData.name,
          description: moduleData.description || '',
          severity: moduleData.severity || 'MEDIUM', // Ensure uppercase
        };

        const response = await this.makeAPIRequest(
          `/test-plans/${testPlanId}/modules`,
          'POST',
          apiData,
        );

        if (!response.success) {
          throw new Error(response.error || 'Failed to create module');
        }

        // Clear cache to force refresh
        this.cache.delete(`testplan_${testPlanId}`);
        return response.data;
      } catch (error) {
        throw error;
      }
    }

    // Create new suite
    async createSuite(testPlanId, moduleSlug, suiteData) {
      try {
        console.log('Creating suite:', { testPlanId, moduleSlug, suiteData });

        // Ensure proper API format
        const apiData = {
          name: suiteData.name,
          description: suiteData.description || '',
        };

        const response = await this.makeAPIRequest(
          `/test-plans/${testPlanId}/modules/${moduleSlug}/suites`,
          'POST',
          apiData,
        );

        if (!response.success) {
          throw new Error(response.error || 'Failed to create suite');
        }

        // Clear cache to force refresh
        this.cache.delete(`testplan_${testPlanId}`);
        return response.data;
      } catch (error) {
        throw error;
      }
    }

    // Fetch cases for a specific suite (on-demand)
    async getSuiteCases(testPlanId, moduleSlug, suiteSlug) {
      try {
        const res = await this.makeAPIRequest(
          `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases`,
        );
        return res?.data?.data || res?.data || [];
      } catch (error) {
        throw error;
      }
    }

    // Initialize for current page
    async initializeForCurrentPage(currentUrl = null) {
      try {
        // Use provided URL or get from current context
        const urlToCheck = currentUrl || window.location.href;

        // Find matching application
        const application = await this.findApplicationByUrl(urlToCheck);

        if (!application) {
          return {
            hasApplication: false,
            message: 'No Voidr application configured for this URL',
          };
        }

        // Find test plan for application
        const testPlan = await this.findTestPlanForApplication(application.id || application._id);

        if (!testPlan) {
          return {
            hasApplication: true,
            hasTestPlan: false,
            application: application,
            message: 'No test plan found for this application',
          };
        }

        // Get test plan content
        const content = await this.getTestPlanContent(testPlan.id);

        return {
          hasApplication: true,
          hasTestPlan: true,
          application: application,
          testPlan: testPlan,
          content: content,
          message: `Ready for testing: ${application.name}`,
        };
      } catch (error) {
        return {
          hasApplication: false,
          error: error.message,
        };
      }
    }

    // Make authenticated API request via background script
    async makeAPIRequest(endpoint, method = 'GET', data = null) {
      return new Promise((resolve) => {
        try {
          console.log(
            '[Service.api] →',
            method,
            endpoint,
            data ? JSON.stringify(data).slice(0, 500) : '',
          );
        } catch (_) {}
        chrome.runtime.sendMessage(
          {
            action: 'apiRequest',
            endpoint: endpoint,
            method: method,
            data: data,
          },
          (response) => {
            try {
              if (!response) {
                console.warn('[Service.api] ← No response');
                resolve({ success: false, error: 'No response' });
                return;
              }
              if (response.success) {
                console.log('[Service.api] ← success');
              } else {
                console.warn('[Service.api] ← error:', response.error);
              }
              resolve(response);
            } catch (e) {
              resolve({ success: false, error: e.message || 'Unknown error' });
            }
          },
        );
      });
    }

    // Generate slug from name (same logic as platform)
    generateSlug(name) {
      return name
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
    }

    // Clear cache
    clearCache() {
      this.cache.clear();
    }
  }

  // Export singleton instance
  const testPlanningService = new TestPlanningService();

  // Make available globally in content script
  if (typeof window !== 'undefined') {
    window.testPlanningService = testPlanningService;
  }
}
