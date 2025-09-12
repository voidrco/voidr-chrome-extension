/* Port of legacy services/defectsService.js with same API surface */

export class DefectsService {
  private cache: Map<string, any> = new Map();

  // Make authenticated API request via background script
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

  // Utilities
  generateDefectSlug(title: string): string {
    try {
      const timestamp = Date.now().toString().slice(-5);
      const titlePart = String(title || 'untitled')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 10);
      return `DEF-${titlePart}-${timestamp}`.toUpperCase();
    } catch (e) {
      console.error('[DefectsService.generateDefectSlug] Failed to generate slug:', e);
      return `DEF-${Date.now()}`;
    }
  }

  sanitizeCreateData(data: any): any {
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
      reportedBy: data.reportedBy,
      assignee: data.assignee,
      applicationId: data.applicationId,
      applicationEnvironment: data.applicationEnvironment,
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
  async listDefects(
    filters: Record<string, any> = {},
  ): Promise<{ items: any[]; total: number; page: number; limit: number }> {
    const params = new URLSearchParams();
    const isValid = (val: any) =>
      val !== null &&
      val !== undefined &&
      String(val).trim() !== '' &&
      String(val).toLowerCase() !== 'undefined' &&
      String(val).toLowerCase() !== 'null';

    if (isValid(filters.page)) {
      const p = Number(filters.page);
      if (Number.isFinite(p) && p > 0) params.set('page', String(p));
    }
    if (isValid(filters.limit)) {
      const l = Number(filters.limit);
      if (Number.isFinite(l) && l > 0) params.set('limit', String(l));
    }
    if (isValid(filters.sortBy)) params.set('sortBy', String(filters.sortBy));
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
      const val = (filters as any)[key];
      if (isValid(val)) params.set(key, String(val));
    });

    const query = params.toString();
    const endpoint = query ? `/defects?${query}` : '/defects';
    const res = await this.makeAPIRequest(endpoint, 'GET');
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 20;
    if (!res || !res.success) return { items: [], total: 0, page, limit };
    const payload = res.data || {};
    const data = payload.data || payload || [];
    const items = Array.isArray(data) ? data : Array.isArray(payload) ? payload : ([] as any[]);
    return {
      items,
      total: payload.total || items.length || 0,
      page: payload.page || page,
      limit: payload.limit || limit,
    };
  }

  async getDefect(idOrSlug: string): Promise<any> {
    const res = await this.makeAPIRequest(`/defects/${encodeURIComponent(idOrSlug)}`, 'GET');
    if (!res || !res.success) throw new Error(res?.error || 'Failed to fetch defect');
    return res.data?.data || res.data;
  }

  async createDefect(data: any): Promise<any> {
    const payload = this.sanitizeCreateData(data);
    const res = await this.makeAPIRequest(`/defects`, 'POST', payload);
    if (!res || !res.success) throw new Error(res?.error || 'Failed to create defect');
    return res.data?.data || res.data;
  }

  async updateDefect(idOrSlug: string, updates: any): Promise<any> {
    const res = await this.makeAPIRequest(
      `/defects/${encodeURIComponent(idOrSlug)}`,
      'PATCH',
      updates,
    );
    if (!res || !res.success) throw new Error(res?.error || 'Failed to update defect');
    return res.data?.data || res.data;
  }

  async updateDefectAttachments(idOrSlug: string, attachments: any[]): Promise<any> {
    const res = await this.makeAPIRequest(`/defects/${encodeURIComponent(idOrSlug)}`, 'PATCH', {
      attachments: attachments || [],
    });
    if (!res || !res.success) throw new Error(res?.error || 'Failed to update attachments');
    return res.data?.data || res.data;
  }

  async deleteDefect(idOrSlug: string): Promise<boolean> {
    const res = await this.makeAPIRequest(`/defects/${encodeURIComponent(idOrSlug)}`, 'DELETE');
    if (!res) return false;
    if (res.success) return true;
    if (res.status === 204) return true;
    return false;
  }

  async assignDefect(idOrSlug: string, assignee: string): Promise<any> {
    return this.updateDefect(idOrSlug, { status: 'in_progress', assignee });
  }

  async resolveDefect(idOrSlug: string, options: any = {}): Promise<any> {
    const updates = {
      status: 'resolved',
      resolvedAt: options.resolvedAt || new Date().toISOString(),
      fixVersion: options.fixVersion,
      assignee: options.assignee,
      resolutionComment: options.resolutionComment,
    };
    return this.updateDefect(idOrSlug, updates);
  }

  async uploadAttachment(file: File, metadata: Record<string, any> = {}): Promise<any> {
    if (!window.privateStorageService) throw new Error('Private storage service not available');
    const storageResponse = await window.privateStorageService.uploadFile(
      file,
      'defects',
      metadata,
    );
    const id =
      typeof crypto !== 'undefined' && (crypto as any).randomUUID
        ? (crypto as any).randomUUID()
        : String(Date.now());
    return {
      id,
      name: (storageResponse as any).fileName || (file as any).name,
      url: (storageResponse as any).key || (storageResponse as any).fileKey,
      storagePayload: {
        key: (storageResponse as any).key || (storageResponse as any).fileKey,
        fileName: (storageResponse as any).fileName || (file as any).name,
        contentType: (storageResponse as any).contentType || (file as any).type,
        size: (storageResponse as any).size || (file as any).size,
        metadata: (storageResponse as any).metadata || metadata,
      },
    };
  }
}

declare global {
  interface Window {
    defectsService?: DefectsService;
    privateStorageService?: any;
  }
}

if (typeof window !== 'undefined') {
  if (!window.defectsService) {
    window.defectsService = new DefectsService();
  }
}

export const defectsService =
  typeof window !== 'undefined' && window.defectsService
    ? window.defectsService
    : new DefectsService();
