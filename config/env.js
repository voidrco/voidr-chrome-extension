/*
  Environment variables for the Voidr extension.
  Fill in values as needed. These override built-in defaults.

  Note: Do NOT commit secrets. This file is meant for local/dev packaging.
*/

(function initializeVoidrEnv() {
  var env = {
    ENVIRONMENT: 'development',
    VOIDR_API_BASE_URL: 'http://localhost:3000/v1',
    VOIDR_PLATFORM_URL: 'http://localhost:3030',
    VOIDR_COLLECTOR_URL: 'http://localhost:3100',
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.__VOIDR_ENV__ = env;
  } else if (typeof window !== 'undefined') {
    window.__VOIDR_ENV__ = env;
  } else if (typeof self !== 'undefined') {
    self.__VOIDR_ENV__ = env;
  }
})();
