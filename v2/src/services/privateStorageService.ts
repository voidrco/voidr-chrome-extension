/* Port of legacy services/privateStorageService.js with same API surface */

export class PrivateStorageService {
  private baseUrl: string = '/private-storage';

  async generateUploadUrl(request: any): Promise<any> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'apiRequest',
          endpoint: `${this.baseUrl}/upload-url`,
          method: 'POST',
          data: request,
        },
        (response) => {
          if (!response || !response.success) {
            resolve({ error: response?.error || 'Failed to generate upload URL' });
            return;
          }
          const data = response.data?.data || response.data;
          resolve(data);
        },
      );
    });
  }

  async uploadToSignedUrl(uploadUrl: string, file: File): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
    });
    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
    }
  }

  async confirmUpload(request: any): Promise<any> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'apiRequest',
          endpoint: `${this.baseUrl}/confirm-upload`,
          method: 'POST',
          data: request,
        },
        (response) => {
          if (!response || !response.success) {
            resolve({ error: response?.error || 'Failed to confirm upload' });
            return;
          }
          const data = response.data?.data || response.data;
          resolve(data);
        },
      );
    });
  }

  async deleteFile(key: string): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: 'apiRequest',
          endpoint: `${this.baseUrl}/files`,
          method: 'DELETE',
          data: { key },
        },
        (response) => {
          resolve(!!(response && response.success));
        },
      );
    });
  }

  async uploadFile(
    file: File,
    folder: string = 'test-cases',
    metadata: Record<string, any> = {},
  ): Promise<any> {
    const presign = await this.generateUploadUrl({
      fileName: file.name,
      contentType: file.type,
      folder,
      metadata,
    });
    if (!presign || (presign as any).error || !(presign as any).uploadUrl) {
      throw new Error((presign as any)?.error || 'Could not presign upload');
    }
    await this.uploadToSignedUrl((presign as any).uploadUrl, file);
    const confirmed = await this.confirmUpload({
      fileKey: (presign as any).fileKey,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      metadata,
    });
    if (!confirmed || (confirmed as any).error) {
      throw new Error((confirmed as any)?.error || 'Could not confirm upload');
    }
    return {
      key: (confirmed as any).key || (confirmed as any).fileKey,
      fileKey: (confirmed as any).key || (confirmed as any).fileKey,
      fileName: (confirmed as any).fileName || file.name,
      contentType: (confirmed as any).contentType || file.type,
      size: (confirmed as any).size || file.size,
      metadata: (confirmed as any).metadata || metadata,
    };
  }
}

declare global {
  interface Window {
    privateStorageService?: PrivateStorageService;
  }
}

if (typeof window !== 'undefined') {
  if (!window.privateStorageService) {
    window.privateStorageService = new PrivateStorageService();
  }
}

export const privateStorageService =
  typeof window !== 'undefined' && window.privateStorageService
    ? window.privateStorageService
    : new PrivateStorageService();
