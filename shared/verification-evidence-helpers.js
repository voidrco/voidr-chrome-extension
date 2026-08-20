(function exposeVerificationEvidenceHelpers(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.VoidrVerificationEvidence = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEvidenceHelpers() {
  const LOCAL_REF = /^verification-(?:evidence|crop)-local:[A-Za-z0-9_-]+$/;

  function isLocalEvidenceRef(value) {
    return typeof value === 'string' && LOCAL_REF.test(value);
  }

  function hasLocalEvidenceRefs(input) {
    return Boolean(
      input &&
        typeof input === 'object' &&
        (isLocalEvidenceRef(input.screenshotRef) || isLocalEvidenceRef(input.cropRef)),
    );
  }

  function replacePendingEvidenceRef(pending, localRef, durableRef) {
    return (Array.isArray(pending) ? pending : []).map((entry) => ({
      ...entry,
      input: {
        ...(entry.input || {}),
        ...(entry.input?.screenshotRef === localRef ? { screenshotRef: durableRef } : {}),
        ...(entry.input?.cropRef === localRef ? { cropRef: durableRef } : {}),
      },
    }));
  }

  return { isLocalEvidenceRef, hasLocalEvidenceRefs, replacePendingEvidenceRef };
});
