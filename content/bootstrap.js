(function bootstrapLoopRecording() {
  if (window !== window.top || !globalThis.VoidrLoopBootstrap) return;

  const parsed = globalThis.VoidrLoopBootstrap.parseAndStripLoopDeepLink(window.location.href);
  if (!parsed) return;

  // Reset at document_start and again when layout becomes measurable. The
  // document_end recorder consumes the marker for one final reset immediately
  // before collector initialization.
  globalThis.__voidrLoopBootstrapFreshViewport = true;
  const prepareViewport = () =>
    globalThis.VoidrLoopBootstrap.prepareAutomaticLoopViewport(window);
  prepareViewport();
  document.addEventListener('DOMContentLoaded', prepareViewport, { once: true });
  window.addEventListener('load', prepareViewport, { once: true });

  // Strip the capability synchronously at document_start, before target scripts
  // and analytics can observe it. Staging happens only in extension-owned state.
  try {
    window.history.replaceState(window.history.state, '', parsed.safeUrl);
  } catch (_) {}

  globalThis.__voidrLoopBootstrapStagePromise = new Promise((resolve) => {
    if (!parsed.staged) {
      globalThis.__voidrLoopBootstrapFailureCode = parsed.failureCode || 'malformed_bootstrap';
      resolve({ ok: false, code: globalThis.__voidrLoopBootstrapFailureCode });
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          action: 'voidr:stageLoopDeepLink',
          scenarioId: parsed.staged.scenarioId,
          token: parsed.staged.token,
          cycleId: parsed.staged.cycleId,
          transportVersion: parsed.staged.transportVersion,
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;
          const ok = !runtimeError && response?.success === true;
          if (!ok) globalThis.__voidrLoopBootstrapFailureCode = 'extension_unavailable';
          resolve({
            ok,
            ...(ok ? {} : { code: globalThis.__voidrLoopBootstrapFailureCode }),
          });
        },
      );
    } catch (_) {
      globalThis.__voidrLoopBootstrapFailureCode = 'extension_unavailable';
      resolve({ ok: false, code: globalThis.__voidrLoopBootstrapFailureCode });
    }
  });
})();
