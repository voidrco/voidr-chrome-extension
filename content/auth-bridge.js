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
    if (!data) return;

    if (data.source === 'voidr-auth-interceptor' && data.type === 'voidr:authToken') {
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
      return;
    }

    // The recorder widget can add a second registered product while a capture
    // is already running. Keep this as an internal platform/extension command:
    // no assistant prompt or model-generated recordingTargets are required.
    if (data.source === 'voidr-platform' && data.type === 'voidr:addRecordingTarget') {
      var target = data.target;
      if (!data.requestId || !target || !target.applicationId || !target.targetUrl) return;
      try {
        var parsed = new URL(target.targetUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      } catch (_) {
        return;
      }
      try {
        chrome.runtime.sendMessage(
          {
            action: 'voidr:addRecordingTarget',
            target: target,
            captureBundleId: data.captureBundleId || undefined,
            recordingUrl: data.recordingUrl || target.targetUrl,
          },
          function (response) {
            var runtimeError = chrome.runtime.lastError;
            window.postMessage(
              {
                source: 'voidr-extension',
                type: 'voidr:addRecordingTargetResult',
                requestId: data.requestId,
                success: !runtimeError && response && response.success === true,
                error: runtimeError
                  ? runtimeError.message
                  : response && response.error
                    ? response.error
                    : undefined,
              },
              window.location.origin,
            );
          },
        );
      } catch (error) {
        window.postMessage(
          {
            source: 'voidr-extension',
            type: 'voidr:addRecordingTargetResult',
            requestId: data.requestId,
            success: false,
            error: error && error.message ? error.message : 'Extension unavailable',
          },
          window.location.origin,
        );
      }
    }
  });
})();
