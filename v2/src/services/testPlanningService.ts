/* Port of legacy services/testPlanningService.js with same API surface */

export class TestPlanningService {
  private currentApplication: any | null = null;
  private currentTestPlan: any | null = null;
  private cache: Map<string, any> = new Map();

  async findApplicationByUrl(currentUrl: string): Promise<any | null> {
    try {
      const appsResponse = await this.makeAPIRequest(
        '/applications?page=1&limit=100&sortBy=createdAt&sortDir=desc',
      );
      if (!appsResponse.success) return null;
      const applications = appsResponse.data?.data || appsResponse.data || [];
      for (const app of applications) {
        const appId = app.id || app._id;
        if (!appId || appId === 'undefined') continue;
        const envsResponse = await this.makeAPIRequest(`/applications/${appId}/environments`);
        if (!envsResponse.success) continue;
        const environments = envsResponse.data?.data || envsResponse.data || [];
        for (const env of environments) {
          if (env.applicationUrl && this.urlMatches(currentUrl, env.applicationUrl)) {
            this.currentApplication = { ...app, id: appId, environment: env };
            return this.currentApplication;
          }
        }
      }
      return null;
    } catch (error) {
      console.error('Error finding application by URL:', error);
      return null;
    }
  }

  urlMatches(currentUrl: string, envUrl: string): boolean {
    try {
      if (!currentUrl || !envUrl) return false;
      let current, env;
      try {
        current = new URL(currentUrl);
        env = new URL(envUrl);
      } catch {
        return currentUrl.includes(envUrl) || envUrl.includes(currentUrl);
      }
      if (current.hostname === env.hostname && current.port === env.port) return true;
      if (current.hostname === env.hostname) return true;
      if (
        current.hostname.endsWith('.' + env.hostname) ||
        env.hostname.endsWith('.' + current.hostname)
      )
        return true;
      const isCurrentLocalhost =
        current.hostname === 'localhost' || current.hostname === '127.0.0.1';
      const isEnvLocalhost = env.hostname === 'localhost' || env.hostname === '127.0.0.1';
      if (isCurrentLocalhost && isEnvLocalhost) return current.port === env.port;
      if (currentUrl.startsWith(envUrl)) return true;
      if (envUrl.startsWith(currentUrl)) return true;
      return false;
    } catch (e) {
      console.warn('Error comparing URLs:', e, { currentUrl, envUrl });
      return false;
    }
  }

  async findTestPlanForApplication(applicationId: string): Promise<any | null> {
    try {
      const response = await this.makeAPIRequest(
        `/test-plans?applicationId=${applicationId}&page=1&limit=10&sortBy=updatedAt&sortDir=desc`,
      );
      if (!response.success) return null;
      const testPlans = response.data?.data || response.data || [];
      if (!testPlans.length) return null;
      const activePlan = testPlans.find((p: any) => p.status === 'ACTIVE');
      const draftPlan = testPlans.find((p: any) => p.status === 'DRAFT');
      const selectedPlan = activePlan || draftPlan || testPlans[0];
      const planId = selectedPlan.id || selectedPlan._id;
      if (!planId || planId === 'undefined') return null;
      this.currentTestPlan = { ...selectedPlan, id: planId };
      return this.currentTestPlan;
    } catch (error) {
      console.error('Error finding test plan:', error);
      return null;
    }
  }

  async getTestPlanContent(testPlanId: string): Promise<any> {
    try {
      const cacheKey = `testplan_${testPlanId}`;
      if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
      if (!testPlanId || testPlanId === 'undefined')
        throw new Error('Invalid test plan ID provided');
      const planRes = await this.makeAPIRequest(`/test-plans/${testPlanId}`);
      if (!planRes.success) throw new Error('Failed to fetch test plan');
      const modulesRes = await this.makeAPIRequest(`/test-plans/${testPlanId}/modules`);
      const rawModules = modulesRes?.data?.data || modulesRes?.data || [];
      const modulesWithSuites = await Promise.all(
        rawModules.map(async (mod: any) => {
          const moduleId = mod.id || mod._id;
          const moduleSlug = mod.slug;
          let suites: any[] = [];
          if (moduleSlug) {
            const suitesRes = await this.makeAPIRequest(
              `/test-plans/${testPlanId}/modules/${moduleSlug}/suites`,
            );
            suites = suitesRes?.data?.data || suitesRes?.data || [];
          }
          return { ...mod, id: moduleId, suites: suites || [] };
        }),
      );
      const content = { testPlan: planRes.data, modules: modulesWithSuites };
      this.cache.set(cacheKey, content);
      setTimeout(() => this.cache.delete(cacheKey), 5 * 60 * 1000);
      return content;
    } catch (error) {
      throw error;
    }
  }

  async createTestPlan(applicationId: string, planData: any): Promise<any> {
    if (!applicationId) throw new Error('Missing applicationId');
    const apiData = {
      applicationId,
      name: planData?.name,
      description: planData?.description || '',
      status: planData?.status || 'DRAFT',
    };
    const response = await this.makeAPIRequest(`/test-plans`, 'POST', apiData);
    if (!response?.success) throw new Error(response?.error || 'Failed to create test plan');
    this.cache.clear();
    return response.data;
  }

  async createModule(testPlanId: string, moduleData: any): Promise<any> {
    const apiData = {
      name: moduleData.name,
      description: moduleData.description || '',
      severity: moduleData.severity || 'MEDIUM',
    };
    const response = await this.makeAPIRequest(
      `/test-plans/${testPlanId}/modules`,
      'POST',
      apiData,
    );
    if (!response.success) throw new Error(response.error || 'Failed to create module');
    this.cache.delete(`testplan_${testPlanId}`);
    return response.data;
  }

  async createSuite(testPlanId: string, moduleSlug: string, suiteData: any): Promise<any> {
    const apiData = { name: suiteData.name, description: suiteData.description || '' };
    const response = await this.makeAPIRequest(
      `/test-plans/${testPlanId}/modules/${moduleSlug}/suites`,
      'POST',
      apiData,
    );
    if (!response.success) throw new Error(response.error || 'Failed to create suite');
    this.cache.delete(`testplan_${testPlanId}`);
    return response.data;
  }

  async getSuiteCases(testPlanId: string, moduleSlug: string, suiteSlug: string): Promise<any[]> {
    const res = await this.makeAPIRequest(
      `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases`,
    );
    return res?.data?.data || res?.data || [];
  }

  // Initialize for current page (paridade com legado)
  async initializeForCurrentPage(currentUrl: string | null = null): Promise<any> {
    try {
      const urlToCheck = currentUrl || (typeof window !== 'undefined' ? window.location.href : '');

      const application = await this.findApplicationByUrl(urlToCheck);
      if (!application) {
        return {
          hasApplication: false,
          message: 'No Voidr application configured for this URL',
        };
      }

      const testPlan = await this.findTestPlanForApplication(application.id || application._id);
      if (!testPlan) {
        return {
          hasApplication: true,
          hasTestPlan: false,
          application,
          message: 'No test plan found for this application',
        };
      }

      const content = await this.getTestPlanContent(testPlan.id);
      return {
        hasApplication: true,
        hasTestPlan: true,
        application,
        testPlan,
        content,
        message: `Ready for testing: ${application.name}`,
      };
    } catch (error: any) {
      return {
        hasApplication: false,
        error: error?.message || 'Unknown error',
      };
    }
  }

  async createTestCase(
    testPlanId: string,
    moduleSlug: string,
    suiteSlug: string,
    testCaseData: any,
  ): Promise<any> {
    const apiData: any = {
      name: testCaseData.name,
      objective: testCaseData.objective || '',
      prerequisites: Array.isArray(testCaseData.prerequisites)
        ? testCaseData.prerequisites
        : testCaseData.prerequisites
          ? [testCaseData.prerequisites]
          : [],
      expectedResult: testCaseData.expectedResult || '',
      type: 'MANUAL',
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
    if (!response.success) throw new Error(response.error || 'Failed to create test case');
    this.cache.delete(`testplan_${testPlanId}`);
    return response.data;
  }

  async getTestCase(
    testPlanId: string,
    moduleSlug: string,
    suiteSlug: string,
    testCaseSlug: string,
  ): Promise<any> {
    const response = await this.makeAPIRequest(
      `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases/${testCaseSlug}`,
    );
    if (!response?.success) throw new Error(response?.error || 'Failed to fetch test case');
    return response?.data?.data || response?.data || response;
  }

  async updateTestCase(
    testPlanId: string,
    moduleSlug: string,
    suiteSlug: string,
    testCaseSlug: string,
    updates: any,
  ): Promise<any> {
    const apiData: any = {};
    if (Object.prototype.hasOwnProperty.call(updates, 'name')) apiData.name = updates.name;
    if (Object.prototype.hasOwnProperty.call(updates, 'objective'))
      apiData.objective = updates.objective;
    if (Object.prototype.hasOwnProperty.call(updates, 'prerequisites'))
      apiData.prerequisites = Array.isArray(updates.prerequisites)
        ? updates.prerequisites
        : updates.prerequisites
          ? [updates.prerequisites]
          : [];
    if (Object.prototype.hasOwnProperty.call(updates, 'expectedResult'))
      apiData.expectedResult = updates.expectedResult;
    if (Object.prototype.hasOwnProperty.call(updates, 'type')) apiData.type = updates.type;
    if (Object.prototype.hasOwnProperty.call(updates, 'status')) apiData.status = updates.status;
    if (Object.prototype.hasOwnProperty.call(updates, 'attachments'))
      apiData.attachments = updates.attachments || [];
    if (Object.prototype.hasOwnProperty.call(updates, 'sessionId'))
      apiData.sessionId = updates.sessionId;
    const response = await this.makeAPIRequest(
      `/test-plans/${testPlanId}/modules/${moduleSlug}/suites/${suiteSlug}/cases/${testCaseSlug}`,
      'PATCH',
      apiData,
    );
    if (!response?.success) throw new Error(response?.error || 'Failed to update test case');
    this.cache.delete(`testplan_${testPlanId}`);
    return response.data;
  }

  // Generate slug from name (same logic as platform/legacy)
  generateSlug(name: string): string {
    return String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  clearCache(): void {
    this.cache.clear();
  }

  // Messaging via background (paridade com legacy)
  async makeAPIRequest(endpoint: string, method: string = 'GET', data: any = null): Promise<any> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'apiRequest', endpoint, method, data }, (response) => {
        try {
          if (!response) {
            resolve({ success: false, error: 'No response' });
            return;
          }
          resolve(response);
        } catch (e: any) {
          resolve({ success: false, error: e?.message || 'Unknown error' });
        }
      });
    });
  }
}

// Singleton global para compatibilidade (window.testPlanningService)
// Evita redefinir se já existir
declare global {
  interface Window {
    testPlanningService?: TestPlanningService;
  }
}

if (typeof window !== 'undefined') {
  if (!window.testPlanningService) {
    window.testPlanningService = new TestPlanningService();
  }
}

export const testPlanningService =
  typeof window !== 'undefined' && window.testPlanningService
    ? window.testPlanningService
    : new TestPlanningService();
