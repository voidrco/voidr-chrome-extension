// Voidr Extension — Auth token interceptor (MAIN world)
//
// The platform configures Auth0 with `cacheLocation: 'memory'`, so the access
// token never reaches localStorage — the old localStorage-based capture finds
// nothing. Instead we read the `Authorization: Bearer` header off the platform's
// own authenticated requests (fetch + XHR/axios) and hand it to auth-bridge.js,
// which forwards it to the background for validation. Restricted to Voidr
// origins via the manifest content_scripts match list.
(function initVoidrAuthInterceptor() {
  if (window.__voidrAuthInterceptorInstalled) return;
  window.__voidrAuthInterceptorInstalled = true;

  var lastPublished = null;

  function publish(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return;
    var match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (!match) return;
    var token = match[1];
    if (token === lastPublished) return;
    lastPublished = token;
    try {
      window.postMessage(
        { source: 'voidr-auth-interceptor', type: 'voidr:authToken', token: token },
        window.location.origin,
      );
    } catch (_) {}
  }

  function readAuthHeader(headers) {
    try {
      if (!headers) return null;
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get('authorization');
      }
      if (Array.isArray(headers)) {
        for (var i = 0; i < headers.length; i++) {
          if (headers[i] && String(headers[i][0]).toLowerCase() === 'authorization') {
            return headers[i][1];
          }
        }
        return null;
      }
      for (var key in headers) {
        if (String(key).toLowerCase() === 'authorization') return headers[key];
      }
    } catch (_) {}
    return null;
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var auth = readAuthHeader(init && init.headers);
        if (!auth && input && typeof input === 'object') auth = readAuthHeader(input.headers);
        publish(auth);
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (name && String(name).toLowerCase() === 'authorization') publish(value);
    } catch (_) {}
    return origSetRequestHeader.apply(this, arguments);
  };
})();
