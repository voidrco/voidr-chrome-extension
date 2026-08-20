(function (root, factory) {
  const api = factory();
  root.VoidrSessionStopHelpers = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  async function quiesceTrackedTabs(tabIds, stopTab) {
    const ids = [...new Set((tabIds || []).filter(Number.isInteger))];
    const settled = await Promise.all(
      ids.map(async (tabId) => {
        try {
          const result = await stopTab(tabId);
          return { tabId, ...result };
        } catch (error) {
          return {
            tabId,
            ok: false,
            flushed: false,
            error: error?.message || String(error),
          };
        }
      }),
    );
    return {
      results: settled,
      failures: settled.filter(
        (result) =>
          result?.ok !== true ||
          (!result?.legacy && !result?.unavailable && result?.flushed !== true),
      ),
    };
  }

  function authoritativeFinalChunkSeq(results) {
    return (results || []).reduce((max, result) => {
      if (result?.finalChunkSeq == null) return max;
      const seq = Number(result.finalChunkSeq);
      return Number.isInteger(seq) && seq >= 0 ? Math.max(max, seq) : max;
    }, -1);
  }

  function groupResultsBySession(results) {
    const groups = new Map();
    for (const result of results || []) {
      const sessionId =
        typeof result?.sessionId === 'string' && result.sessionId.trim()
          ? result.sessionId.trim()
          : null;
      if (!sessionId) continue;
      if (!groups.has(sessionId)) groups.set(sessionId, []);
      groups.get(sessionId).push(result);
    }
    return groups;
  }

  async function finalizeTrackedTabs({
    tabIds,
    stopTab,
    sealSession,
    waitForCompatibility = async () => {},
  }) {
    const quiescence = await quiesceTrackedTabs(tabIds, stopTab);
    const grouped = groupResultsBySession(quiescence.results);
    const finalizations = {};
    const finalizationFailures = [];

    for (const [sessionId, sessionResults] of grouped) {
      const sessionFailures = sessionResults.filter(
        (result) =>
          result?.ok !== true ||
          (!result?.legacy && !result?.unavailable && result?.flushed !== true),
      );
      if (sessionFailures.length > 0) {
        finalizationFailures.push({
          sessionId,
          error: 'One or more tabs for this session failed to flush',
        });
        continue;
      }

      const compatibilityResults = sessionResults.filter(
        (result) => result?.legacy || result?.unavailable,
      );
      try {
        if (compatibilityResults.length > 0) {
          await waitForCompatibility(compatibilityResults);
        }
        const maxFinalChunkSeq = authoritativeFinalChunkSeq(sessionResults);
        const finalization = await sealSession({
          sessionId,
          // ACK watermarks are session-scoped. Never let a rotated session's
          // sequence seal the canonical session (or any sibling session).
          finalizedThrough:
            compatibilityResults.length === 0 && maxFinalChunkSeq >= 0 ? maxFinalChunkSeq : null,
          compatibilityResults,
          results: sessionResults,
        });
        finalizations[sessionId] =
          compatibilityResults.length > 0
            ? {
                ...finalization,
                sealed: false,
                finalized: false,
                degraded: true,
                error: 'Legacy collector has no acknowledged final chunk watermark',
              }
            : finalization;
      } catch (error) {
        finalizations[sessionId] = {
          sessionId,
          sealed: false,
          finalized: false,
          degraded: true,
          error: error?.message || String(error),
        };
      }

      if (
        finalizations[sessionId]?.sealed !== true ||
        finalizations[sessionId]?.finalized !== true
      ) {
        finalizationFailures.push({
          sessionId,
          error: finalizations[sessionId]?.error || 'Session seal was not confirmed',
        });
      }
    }

    const missingSessionResults = quiescence.results.filter(
      (result) =>
        result?.ok === true && !(typeof result?.sessionId === 'string' && result.sessionId.trim()),
    );
    for (const result of missingSessionResults) {
      finalizationFailures.push({
        tabId: result.tabId,
        sessionId: null,
        error: 'Collector stop result did not include a sessionId',
      });
    }

    const previouslyFinalizedSessionIds = quiescence.results
      .filter((result) => result?.ok === true)
      .flatMap((result) =>
        Array.isArray(result?.finalizedSessionIds) ? result.finalizedSessionIds : [],
      )
      .filter((sessionId) => typeof sessionId === 'string' && sessionId);
    const successfullySealedNow = Object.entries(finalizations)
      .filter(([, result]) => result?.sealed === true && result?.finalized === true)
      .map(([sessionId]) => sessionId);
    const successfulSessionIds = [
      ...new Set([...previouslyFinalizedSessionIds, ...successfullySealedNow]),
    ];
    const finalization =
      Object.keys(finalizations).length === 1 ? Object.values(finalizations)[0] : undefined;

    return {
      ...quiescence,
      finalization,
      finalizations,
      finalizationFailures,
      successfulSessionIds,
      partialFailure: quiescence.failures.length > 0 || finalizationFailures.length > 0,
    };
  }

  function isConfirmedCapture(result) {
    return result?.success === true && result?.finalized === true;
  }

  function classifyStopOutcome({
    quiescencePartialFailure = false,
    finalizedSessionIds = [],
    attachmentError = null,
  } = {}) {
    const sealFailed =
      quiescencePartialFailure === true ||
      !Array.isArray(finalizedSessionIds) ||
      finalizedSessionIds.length === 0;
    return {
      sealFailed,
      success: !sealFailed,
      finalized: !sealFailed,
      partial: sealFailed,
      attachmentPending: !sealFailed && Boolean(attachmentError),
    };
  }

  return {
    quiesceTrackedTabs,
    authoritativeFinalChunkSeq,
    groupResultsBySession,
    finalizeTrackedTabs,
    isConfirmedCapture,
    classifyStopOutcome,
  };
});
