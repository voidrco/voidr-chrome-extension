/*
  Loads config/env.local.js (gitignored dev overrides) into extension pages —
  but only when the file actually exists in the unpacked build. A bare
  <script src="env.local.js"> logs a red ERR_FILE_NOT_FOUND in every
  production console, since the file is absent by design outside dev.

  getPackageDirectoryEntry lets us test for the file without issuing the
  request that produces the console error. Env consumers read
  globalThis.__VOIDR_ENV__ lazily (see popup.js getApiBaseUrl), so the
  overrides landing a tick after initial parse is fine.
*/
(function loadLocalEnvOverrides() {
  try {
    if (!chrome?.runtime?.getPackageDirectoryEntry) return;
    chrome.runtime.getPackageDirectoryEntry((root) => {
      root.getFile(
        'config/env.local.js',
        {},
        () => {
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('config/env.local.js');
          document.head.appendChild(s);
        },
        () => {}, // file absent — production build, nothing to load
      );
    });
  } catch (_) {}
})();
