// Private Storage Service for Voidr Extension
// Mirrors the platform's private storage API: presign → upload → confirm

if (typeof window !== 'undefined' && window.privateStorageService) {
  // Already defined – avoid double registration
} else {
  class PrivateStorageService {
    constructor() {
      this.baseUrl = '/private-storage';
    }

    // Generate upload URL (Step 1)
    async generateUploadUrl(request) {
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

    // Upload to signed URL (Step 2)
    async uploadToSignedUrl(uploadUrl, file) {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      }
    }

    // Confirm upload (Step 3)
    async confirmUpload(request) {
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

    // Delete file by key
    async deleteFile(key) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'apiRequest',
            endpoint: `${this.baseUrl}/files`,
            method: 'DELETE',
            data: { key },
          },
          (response) => {
            resolve(response && response.success);
          },
        );
      });
    }

    // Full upload flow convenience
    async uploadFile(file, folder = 'test-cases', metadata = {}) {
      const presign = await this.generateUploadUrl({
        fileName: file.name,
        contentType: file.type,
        folder,
        metadata,
      });
      if (!presign || presign.error || !presign.uploadUrl) {
        throw new Error(presign?.error || 'Could not presign upload');
      }
      await this.uploadToSignedUrl(presign.uploadUrl, file);
      const confirmed = await this.confirmUpload({
        fileKey: presign.fileKey,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
        metadata,
      });
      if (!confirmed || confirmed.error) {
        throw new Error(confirmed?.error || 'Could not confirm upload');
      }
      return {
        key: confirmed.key || confirmed.fileKey,
        fileKey: confirmed.key || confirmed.fileKey,
        fileName: confirmed.fileName || file.name,
        contentType: confirmed.contentType || file.type,
        size: confirmed.size || file.size,
        metadata: confirmed.metadata || metadata,
      };
    }
  }

  const privateStorageService = new PrivateStorageService();
  if (typeof window !== 'undefined') {
    window.privateStorageService = privateStorageService;
  }
}
