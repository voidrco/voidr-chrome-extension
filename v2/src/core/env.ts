type VoidrEnv = {
  ENVIRONMENT?: string;
  VOIDR_API_BASE_URL?: string;
  VOIDR_PLATFORM_URL?: string;
  VOIDR_AUTH0_DOMAIN?: string;
  VOIDR_AUTH0_CLIENT_ID?: string;
  VOIDR_AUTH0_AUDIENCE?: string;
  [key: string]: unknown;
};

let cachedEnv: VoidrEnv | null = null;

export function getEnv(): VoidrEnv {
  if (cachedEnv) return cachedEnv;

  const DEFAULT_ENV: VoidrEnv = {
    ENVIRONMENT: 'development',
    VOIDR_API_BASE_URL: 'https://voidr-service-785568282479.us-central1.run.app/v1',
    VOIDR_PLATFORM_URL: 'https://canary.voidr.co',
    VOIDR_AUTH0_DOMAIN: 'bounties4.us.auth0.com',
    VOIDR_AUTH0_CLIENT_ID: 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS',
    VOIDR_AUTH0_AUDIENCE: 'https://service.bounties4.com/',
  };

  const existing = (globalThis as any).__VOIDR_ENV__ as VoidrEnv | undefined;
  const merged: VoidrEnv = { ...DEFAULT_ENV, ...(existing || {}) };
  try {
    (globalThis as any).__VOIDR_ENV__ = merged;
  } catch (e) {
    // non-silent: surface minimal info without breaking
    console.error('Failed to set __VOIDR_ENV__ on globalThis', e);
  }

  cachedEnv = merged;
  return merged;
}

export function getEnvVar<K extends keyof VoidrEnv>(key: K): VoidrEnv[K] {
  const env = getEnv();
  return env[key];
}
