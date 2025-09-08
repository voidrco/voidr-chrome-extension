// Defects Service for Voidr Extension
// Encapsulates API calls for defects management

if (typeof window !== 'undefined' && window.defectsService) {
  // Already defined – avoid double registration
  // Do nothing
} else {
  class DefectsService {
    constructor() {
      this.cache = new Map();
    }

    // Make authenticated API request via background script
    async makeAPIRequest(endpoint, method = 'GET', data = null) {
      return new Promise((resolve) => {
        try {
          console.log(
            '[DefectsService.api] →',
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
                resolve({ success: false, error: 'No response' });
                return;
              }
              resolve(response);
            } catch (e) {
              resolve({ success: false, error: e.message || 'Unknown error' });
            }
          },
        );
      });
    }

    // Utilities
    generateDefectSlug(title) {
      try {
        const timestamp = Date.now().toString().slice(-5);
        const titlePart = String(title || 'untitled')
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .replace(/\s+/g, '-')
          .slice(0, 10);
        return `DEF-${titlePart}-${timestamp}`.toUpperCase();
      } catch (_) {
        return `DEF-${Date.now()}`;
      }
    }

    sanitizeCreateData(data) {
      const navInfo = {
        os: (typeof navigator !== 'undefined' && (navigator.platform || 'Unknown')) || 'Unknown',
        browser:
          (typeof navigator !== 'undefined' && (navigator.userAgent || 'Unknown')) || 'Unknown',
      };
      return {
        slug: data.slug || this.generateDefectSlug(data.title),
        title: (data.title || '').trim() || 'Untitled Defect',
        description: (data.description || '').trim(),
        status: data.status || 'open',
        severity: data.severity || 'medium',
        priority: data.priority || 'p2',
        reportedBy: data.reportedBy, // optional; backend can infer from token
        assignee: data.assignee,
        applicationId: data.applicationId,
        applicationEnvironment: data.applicationEnvironment, // optional
        platform: {
          os: data.platform?.os || navInfo.os,
          browser: data.platform?.browser || navInfo.browser,
        },
        reproducibility: data.reproducibility || 'always',
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        relations: {
          related: [],
          duplicates: [],
          blocks: [],
          blockedBy: [],
          pullRequests: [],
          issues: [],
          testCases: [],
        },
        targetAt: data.targetAt || undefined,
        resolvedAt: data.resolvedAt || undefined,
        closedAt: data.closedAt || undefined,
        fixVersion: data.fixVersion || undefined,
      };
    }

    // List defects with filters
    async listDefects(filters = {}) {
      const params = new URLSearchParams();

      const isValid = (val) =>
        val !== null &&
        val !== undefined &&
        String(val).trim() !== '' &&
        String(val).toLowerCase() !== 'undefined' &&
        String(val).toLowerCase() !== 'null';

      // Only include pagination and sorting if explicitly provided and valid
      if (isValid(filters.page)) {
        const p = Number(filters.page);
        if (Number.isFinite(p) && p > 0) params.set('page', String(p));
      }
      if (isValid(filters.limit)) {
        const l = Number(filters.limit);
        if (Number.isFinite(l) && l > 0) params.set('limit', String(l));
      }
      if (isValid(filters.sortBy)) {
        params.set('sortBy', String(filters.sortBy));
      }
      if (isValid(filters.sortDir)) {
        const dir = String(filters.sortDir).toLowerCase();
        if (dir === 'asc' || dir === 'desc') params.set('sortDir', dir);
      }

      [
        'slug',
        'status',
        'severity',
        'priority',
        'assignee',
        'applicationEnvironment',
        'search',
      ].forEach((key) => {
        const val = filters[key];
        if (isValid(val)) params.set(key, String(val));
      });

      const query = params.toString();
      const endpoint = query ? `/defects?${query}` : '/defects';
      const res = await this.makeAPIRequest(endpoint, 'GET');
      if (!res || !res.success) return { items: [], total: 0, page: 1, limit: Number(limit) };
      const payload = res.data || {};
      const data = payload.data || payload || [];
      // Normalize array
      const items = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
      return {
        items,
        total: payload.total || items.length || 0,
        page: payload.page || Number(page) || 1,
        limit: payload.limit || Number(limit) || 20,
      };
    }

    // Get a single defect
    async getDefect(idOrSlug) {
      const res = await this.makeAPIRequest(`/defects/${encodeURIComponent(idOrSlug)}`, 'GET');
      if (!res || !res.success) throw new Error(res?.error || 'Failed to fetch defect');
      return res.data?.data || res.data;
    }

    // Create a new defect
    async createDefect(data) {
      const payload = this.sanitizeCreateData(data);
      const res = await this.makeAPIRequest(`/defects`, 'POST', payload);
      if (!res || !res.success) throw new Error(res?.error || 'Failed to create defect');
      return res.data?.data || res.data;
    }

    // Update an existing defect
    async updateDefect(idOrSlug, updates) {
      const res = await this.makeAPIRequest(
        `/defects/${encodeURIComponent(idOrSlug)}`,
        'PATCH',
        updates,
      );
      if (!res || !res.success) throw new Error(res?.error || 'Failed to update defect');
      return res.data?.data || res.data;
    }

    // Update attachments array for a defect
    async updateDefectAttachments(idOrSlug, attachments) {
      const res = await this.makeAPIRequest(`/defects/${encodeURIComponent(idOrSlug)}`, 'PATCH', {
        attachments: attachments || [],
      });
      if (!res || !res.success) throw new Error(res?.error || 'Failed to update attachments');
      return res.data?.data || res.data;
    }

    // Delete a defect
    async deleteDefect(idOrSlug) {
      const res = await this.makeAPIRequest(`/defects/${encodeURIComponent(idOrSlug)}`, 'DELETE');
      if (!res) return false;
      if (res.success) return true;
      if (res.status === 204) return true;
      return false;
    }

    // Convenience methods
    async assignDefect(idOrSlug, assignee) {
      return this.updateDefect(idOrSlug, { status: 'in_progress', assignee });
    }

    async resolveDefect(idOrSlug, options = {}) {
      const updates = {
        status: 'resolved',
        resolvedAt: options.resolvedAt || new Date().toISOString(),
        fixVersion: options.fixVersion,
        assignee: options.assignee,
        resolutionComment: options.resolutionComment,
      };
      return this.updateDefect(idOrSlug, updates);
    }

    // Upload attachment using private storage service
    async uploadAttachment(file, metadata = {}) {
      if (!window.privateStorageService) throw new Error('Private storage service not available');
      const storageResponse = await window.privateStorageService.uploadFile(
        file,
        'defects',
        metadata,
      );
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : String(Date.now());
      return {
        id,
        name: storageResponse.fileName || file.name,
        url: storageResponse.key || storageResponse.fileKey,
        storagePayload: {
          key: storageResponse.key || storageResponse.fileKey,
          fileName: storageResponse.fileName || file.name,
          contentType: storageResponse.contentType || file.type,
          size: storageResponse.size || file.size,
          metadata: storageResponse.metadata || metadata,
        },
      };
    }
  }

  // Export singleton instance
  const defectsService = new DefectsService();
  if (typeof window !== 'undefined') {
    window.defectsService = defectsService;
  }
}
