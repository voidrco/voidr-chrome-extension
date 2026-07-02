// Voidr Extension — Auth token bridge (ISOLATED world)
//
// Receives the bearer token captured by auth-interceptor.js (MAIN world) and
// forwards it to the background, which validates it against /auth/me and stores
// it. Restricted to Voidr origins via the manifest match list; we also re-check
// the hostname here as defense-in-depth so a token is never forwarded from a
// non-Voidr page.
(function initVoidrAuthBridge() {
  var host = location.hostname;
  var isVoidrOrigin =
    host === 'voidr.co' ||
    host.endsWith('.voidr.co') ||
    host === 'localhost' ||
    host === '127.0.0.1';
  if (!isVoidrOrigin) return;

  var lastForwarded = null;

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'voidr-auth-interceptor' || data.type !== 'voidr:authToken') return;
    if (!data.token || data.token === lastForwarded) return;
    lastForwarded = data.token;
    try {
      chrome.runtime.sendMessage(
        { action: 'validateAndStoreToken', token: data.token },
        function () {
          void chrome.runtime.lastError;
        },
      );
    } catch (_) {}
  });
})();
