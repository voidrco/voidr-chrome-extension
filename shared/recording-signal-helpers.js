(function exposeVoidrRecordingSignals(root, factory) {
  const helpers = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (root) root.VoidrRecordingSignals = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRecordingSignalHelpers() {
  const SIGNAL_KEYS = Object.freeze([
    'pages',
    'clicks',
    'requests',
    'errors',
    'notes',
    'voiceNotes',
  ]);

  function create(initialUrl = '') {
    return {
      pages: initialUrl ? 1 : 0,
      clicks: 0,
      requests: 0,
      errors: 0,
      notes: 0,
      voiceNotes: 0,
      lastUrl: String(initialUrl || ''),
    };
  }

  function increment(state, key, amount = 1) {
    if (!state || !SIGNAL_KEYS.includes(key)) return state;
    const delta = Number.isFinite(Number(amount)) ? Math.max(0, Math.floor(Number(amount))) : 0;
    state[key] = Math.max(0, Number(state[key]) || 0) + delta;
    return state;
  }

  function observeUrl(state, nextUrl) {
    if (!state) return state;
    const normalized = String(nextUrl || '');
    if (!normalized || normalized === state.lastUrl) return state;
    state.lastUrl = normalized;
    increment(state, 'pages');
    return state;
  }

  function snapshot(state) {
    return Object.fromEntries(
      SIGNAL_KEYS.map((key) => [key, Math.max(0, Number(state?.[key]) || 0)]),
    );
  }

  return { SIGNAL_KEYS, create, increment, observeUrl, snapshot };
});
