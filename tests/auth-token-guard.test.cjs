const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const { validateAndCommit } = require('../background/auth-candidate.js');

test('invalid candidate cannot replace the stored authentication', async () => {
  let committed = false;
  const result = await validateAndCommit({
    token: 'collector-token',
    validate: async () => false,
    commit: async () => {
      committed = true;
    },
  });

  assert.deepEqual(result, { isAuthenticated: false, ignored: true });
  assert.equal(committed, false);
});

test('manual logout suppression wins over an in-flight validation', async () => {
  let suppressed = false;
  let committed = false;
  const result = await validateAndCommit({
    token: 'auth0-token',
    validate: async () => {
      suppressed = true;
      return { isValid: true, user: { email: 'cosme@example.com' } };
    },
    isSuppressed: async () => suppressed,
    commit: async () => {
      committed = true;
    },
  });

  assert.deepEqual(result, { isAuthenticated: false, ignored: true });
  assert.equal(committed, false);
});

test('validated candidate is committed and returned', async () => {
  const user = { email: 'cosme@example.com' };
  let committed;
  const result = await validateAndCommit({
    token: 'auth0-token',
    validate: async () => ({ isValid: true, user }),
    commit: async (candidate) => {
      committed = candidate;
    },
  });

  assert.deepEqual(committed, { token: 'auth0-token', user });
  assert.deepEqual(result, { isAuthenticated: true, user, token: 'auth0-token' });
});

function loadInterceptor() {
  const messages = [];

  class FakeHeaders {
    constructor(values = {}) {
      this.values = values;
    }

    get(name) {
      const key = Object.keys(this.values).find((candidate) => candidate.toLowerCase() === name);
      return key ? this.values[key] : null;
    }
  }

  class FakeXhr {
    open() {}
    setRequestHeader() {}
  }

  const window = {
    location: { href: 'https://platform.voidr.co/dashboard', origin: 'https://platform.voidr.co' },
    fetch: async () => ({ ok: true }),
    postMessage: (message) => messages.push(message),
  };

  vm.runInNewContext(readFileSync('content/auth-interceptor.js', 'utf8'), {
    window,
    URL,
    WeakMap,
    Headers: FakeHeaders,
    XMLHttpRequest: FakeXhr,
  });

  return { window, FakeXhr, messages };
}

test('fetch interceptor ignores the Collector bearer token', async () => {
  const { window, messages } = loadInterceptor();

  await window.fetch('https://collector.voidr.co/sessions/chunk', {
    headers: { Authorization: 'Bearer collector-token' },
  });
  await window.fetch('https://api.voidr.co/v1/applications', {
    headers: { Authorization: 'Bearer auth0-token' },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].token, 'auth0-token');
});

test('XHR interceptor only publishes tokens sent to the Voidr API', () => {
  const { FakeXhr, messages } = loadInterceptor();
  const collectorRequest = new FakeXhr();
  collectorRequest.open('POST', 'https://collector.voidr.co/sessions/chunk');
  collectorRequest.setRequestHeader('Authorization', 'Bearer collector-token');

  const apiRequest = new FakeXhr();
  apiRequest.open('GET', 'https://api.voidr.co/v1/auth/me');
  apiRequest.setRequestHeader('Authorization', 'Bearer auth0-token');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].token, 'auth0-token');
});

test('authenticated home exposes a logout control backed by persisted suppression', () => {
  const html = readFileSync('popup/popup.html', 'utf8');
  const popup = readFileSync('popup/popup.js', 'utf8');
  const background = readFileSync('background/background.js', 'utf8');

  assert.match(html, /id="auth-logout-btn"/);
  assert.match(popup, /action: 'authLogout'/);
  assert.match(background, /AUTH_SYNC_SUPPRESSED_KEY/);
  assert.match(background, /chrome\.storage\.local\.remove\(\['voidrAuth'\]\)/);
});
