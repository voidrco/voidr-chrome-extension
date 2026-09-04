const PACKAGED_DIRECTORIES = new Set([
  'assets',
  'background',
  'config',
  'content',
  'icons',
  'offscreen',
  'popup',
  'shared',
  'vendor',
]);

export function parseChromeVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value)) {
    throw new Error(`Invalid Chrome extension version: ${JSON.stringify(value)}`);
  }

  const parts = value.split('.').map(Number);
  if (parts.every((part) => part === 0) || parts.some((part) => part > 65535)) {
    throw new Error(`Invalid Chrome extension version: ${JSON.stringify(value)}`);
  }

  return [...parts, 0, 0, 0].slice(0, 4);
}

export function compareChromeVersions(left, right) {
  const leftParts = parseChromeVersion(left);
  const rightParts = parseChromeVersion(right);

  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return Math.sign(leftParts[index] - rightParts[index]);
    }
  }

  return 0;
}

export function isPackagedPath(filePath) {
  if (filePath === 'manifest.json') {
    return true;
  }

  const [directory] = filePath.split('/');
  if (!PACKAGED_DIRECTORIES.has(directory)) {
    return false;
  }

  return filePath !== 'config/env.local.example.js';
}

export function requiresVersionBump(changedPaths) {
  return changedPaths.some(isPackagedPath);
}
