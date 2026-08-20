(function exposeRecordingUxHelpers(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.VoidrRecordingUx = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRecordingUxHelpers() {
  function unwrapApiData(payload) {
    if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
    return payload;
  }

  function isSafeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
      );
    } catch (_) {
      return false;
    }
  }

  function isAllowedLoopTarget(value) {
    if (!isSafeHttpUrl(value)) return false;
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.hostname.endsWith('.local')
    );
  }

  function normalizeLoopScenarios(payload) {
    const data = unwrapApiData(payload);
    if (!Array.isArray(data)) return [];
    return data
      .filter((scenario) => scenario && typeof scenario === 'object')
      .map((scenario) => ({
        id: String(scenario.id || scenario.scenarioId || ''),
        name: String(scenario.name || 'Loop sem nome'),
        status: String(scenario.status || 'draft'),
        cycle: Number.isFinite(Number(scenario.cycle)) ? Number(scenario.cycle) : 0,
        sessionsRecorded: Number.isFinite(Number(scenario.sessionsRecorded))
          ? Number(scenario.sessionsRecorded)
          : 0,
        targetUrl: isSafeHttpUrl(scenario.targetUrl) ? scenario.targetUrl : '',
        applicationName: String(
          scenario.applicationName || scenario.application?.name || scenario.applicationId || '',
        ),
      }))
      .filter((scenario) => scenario.id);
  }

  function isLoopScenarioEligible(scenario) {
    const busy = new Set(['recording', 'ingesting', 'compiling', 'replaying', 'comparing', 'healing']);
    return Boolean(scenario?.id && !busy.has(String(scenario.status || '').toLowerCase()));
  }

  function sanitizeActiveRecording(recording) {
    if (!recording || typeof recording !== 'object') return null;
    const mode = typeof recording.mode === 'string' ? recording.mode : 'test-case';
    const status = ['starting', 'recording', 'stopping'].includes(recording.lifecycle)
      ? recording.lifecycle
      : 'recording';
    return {
      active: true,
      mode,
      name: String(recording.testCaseName || 'Gravação sem nome'),
      startedAt:
        Number.isFinite(Number(recording.startedAt)) && Number(recording.startedAt) > 0
          ? Number(recording.startedAt)
          : null,
      status,
      generation:
        typeof recording.lifecycleGeneration === 'string' ? recording.lifecycleGeneration : null,
    };
  }

  function safeFailureReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return 'Não foi possível iniciar a gravação do Loop.';
    return text.slice(0, 240);
  }

  return {
    unwrapApiData,
    isSafeHttpUrl,
    isAllowedLoopTarget,
    normalizeLoopScenarios,
    isLoopScenarioEligible,
    sanitizeActiveRecording,
    safeFailureReason,
  };
});
