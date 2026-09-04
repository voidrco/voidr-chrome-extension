(function (root, factory) {
  const api = factory();
  root.VoidrAuthCandidate = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  async function validateAndCommit({ token, validate, commit, isSuppressed = async () => false }) {
    if (await isSuppressed()) return { isAuthenticated: false, ignored: true };

    const validation = await validate(token);
    if (!validation?.isValid || !validation.user || (await isSuppressed())) {
      return { isAuthenticated: false, ignored: true };
    }

    await commit({ token, user: validation.user });
    return {
      isAuthenticated: true,
      user: validation.user,
      token,
    };
  }

  return { validateAndCommit };
});
