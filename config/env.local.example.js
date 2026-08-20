/*
  Local development overrides for the Voidr extension.

  Copy this file to `config/env.local.js` (gitignored) and adjust the values.
  It is loaded AFTER `config/env.js` and MERGES on top of the production
  defaults — only set the keys you want to override.
*/

(function initializeVoidrLocalEnv() {
  var overrides = {
    ENVIRONMENT: 'development',
    VOIDR_API_BASE_URL: 'http://localhost:3000/v1',
    VOIDR_PLATFORM_URL: 'http://localhost:3030',
    VOIDR_COLLECTOR_URL: 'http://localhost:3100',
    VOIDR_COLLECTOR_SCRIPT_URL: 'http://localhost:8889/dist/recorder.min.js',
    VERIFICATION_LOCAL_ADAPTER_ENABLED: true,
    VERIFICATION_LOCAL_DEV_KEY: 'voidr-verification-local',
    VERIFICATION_LOCAL_ORGANIZATION: 'org_verification_local',
    VERIFICATION_LOCAL_COLLECTOR_API_KEY: 'voidr-verification-collector-local',
  };

  var root =
    (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof window !== 'undefined' && window) ||
    (typeof self !== 'undefined' && self);
  if (root) {
    root.__VOIDR_ENV__ = Object.assign({}, root.__VOIDR_ENV__, overrides);
  }
})();
