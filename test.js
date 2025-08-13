(function () {
  const STATE = { loaded: new Set() };

  function loadScript(url, id) {
    return new Promise((resolve, reject) => {
      if (id && document.getElementById(id)) {
        STATE.loaded.add(url);
        return resolve();
      }
      const s = document.createElement('script');
      s.src = url;
      if (id) s.id = id;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        STATE.loaded.add(url);
        resolve();
      };
      s.onerror = (e) => reject(new Error('Failed to load ' + url));
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function injectAndInit(config) {
    const { scripts, initOptions } = config;

    // Load in order (if there are dependencies)
    for (let i = 0; i < scripts.length; i++) {
      const { src, id } = scripts[i];
      // eslint-disable-next-line no-await-in-loop
      await loadScript(src, id);
    }

    if (window.VoidrCollector && typeof window.VoidrCollector.init === 'function') {
      window.VoidrCollector.init(initOptions || {});
      console.log('VoidrCollector.init called with:', initOptions);
    } else {
      console.warn('VoidrCollector not available after scripts loaded.');
    }
  }

  // Expose a helper to re-init quickly later from console:
  window.voidrInit = function (overrides = {}) {
    const merged = {
      ...window.__VOIDR_CONFIG__.initOptions,
      ...overrides,
      user: {
        ...(window.__VOIDR_CONFIG__.initOptions.user || {}),
        ...(overrides.user || {}),
      },
    };
    if (window.VoidrCollector && typeof window.VoidrCollector.init === 'function') {
      window.VoidrCollector.init(merged);
      console.log('VoidrCollector re-init with:', merged);
    } else {
      console.warn('VoidrCollector not available yet. Make sure scripts are loaded.');
    }
  };

  // EDIT ONLY THIS CONFIG:
  window.__VOIDR_CONFIG__ = {
    // Add or remove scripts here (first is the recorder)
    scripts: [
      {
        src: 'http://localhost:5173/dist/recorder.min.js',
        // src: 'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js',
        id: '__voidr_recorder__',
      },
      // Example: add another script if needed
      // { src: 'https://example.com/another-lib.js', id: '__another_lib__' },
    ],
    // Options passed to VoidrCollector.init
    initOptions: {
      apiKey: 'f72dfbc0-d648-46fc-bc96-e3a0e5e009ac', // API Key da conta de testes
      user: {
        id: 'voidr-test-user',
        email: 'contact@voidr.co',
      },
      collectorUrl: 'http://localhost:3100',
      meta: {
        hospital: 'Hospital vera cruz',
      },
      // Add other options here as needed
    },
  };

  // Prevent duplicate injection
  const alreadyInjected = window.__VOIDR_INJECTED__;
  window.__VOIDR_INJECTED__ = true;

  if (alreadyInjected) {
    console.log('Scripts already injected. Re-initializing with current config.');
    window.voidrInit(window.__VOIDR_CONFIG__.initOptions);
  } else {
    injectAndInit(window.__VOIDR_CONFIG__).catch((e) => console.error(e));
  }
})();
