import { BASE64_DATA_URL_REGEX, MIN_BASE64_LENGTH } from '../constants.js';

/**
 * Compress a base64-encoded image data URL using canvas.
 * Converts to WebP at reduced quality and dimensions.
 */
export function compressBase64Image(dataUrl, quality = 0.4, maxDim = 480) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(
            1,
            maxDim / Math.max(img.width, img.height),
          );
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const compressed = canvas.toDataURL('image/webp', quality);
          resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch {
      resolve(dataUrl);
    }
  });
}

/**
 * Recursively walk a value (string, array, object) and compress any
 * base64-encoded image data URLs found.
 */
export async function compressBase64InValue(value) {
  if (typeof value === 'string') {
    if (
      value.length >= MIN_BASE64_LENGTH &&
      BASE64_DATA_URL_REGEX.test(value)
    ) {
      return compressBase64Image(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      result[i] = await compressBase64InValue(value[i]);
      if (result[i] !== value[i]) changed = true;
    }
    return changed ? result : value;
  }

  if (value && typeof value === 'object') {
    let changed = false;
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = await compressBase64InValue(value[key]);
      if (result[key] !== value[key]) changed = true;
    }
    return changed ? result : value;
  }

  return value;
}

/**
 * Compress base64 images in all events of a batch.
 */
export async function compressEventsBase64(eventsBatch) {
  return Promise.all(eventsBatch.map((e) => compressBase64InValue(e)));
}
