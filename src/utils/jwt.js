// Renew the ingest JWT this long before it expires
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Read the `exp` (seconds since epoch) from a JWT without verifying its signature
 */
export function decodeJwtExp(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const claims = JSON.parse(atob(padded));
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}
