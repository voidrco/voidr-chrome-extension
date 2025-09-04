(function initializeVoidrEnv() {
  var defaultEnv = {
    ENVIRONMENT: 'development',
    VOIDR_API_BASE_URL: '',
    VOIDR_API_TOKEN: ''
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.__VOIDR_ENV__ = defaultEnv;
  } else if (typeof window !== 'undefined') {
    window.__VOIDR_ENV__ = defaultEnv;
  } else if (typeof self !== 'undefined') {
    self.__VOIDR_ENV__ = defaultEnv;
  }
})();


