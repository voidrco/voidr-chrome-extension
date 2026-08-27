const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const content = readFileSync('content/content.js', 'utf8');
const popup = readFileSync('popup/popup.js', 'utf8');
const background = readFileSync('background/background.js', 'utf8');

test('recording code environment reaches collector init', () => {
  assert.match(popup, /environmentSlug: recordingCodeContext\.environmentSlug/);
  assert.match(content, /environmentSlug: request\.environmentSlug/);
  assert.match(content, /environmentSlug: options\.environmentSlug/);
  assert.match(content, /initOptions\.environment = init\.environmentSlug/);
});

test('onboarding confirmation accepts the service session object shape', () => {
  assert.match(background, /session\?\.collectorSessionId === sessionId/);
});

test('captured session notification stays scoped to its recording code', () => {
  assert.match(background, /code: onboardingLink\.code \|\| undefined/);
  assert.match(background, /confirmed: onboardingLink\.confirmedSessionIds\.includes\(sid\)/);
  assert.match(content, /code: code \|\| undefined/);
  assert.match(content, /confirmed: confirmed === true/);
  assert.match(popup, /eventCode === currentCode/);
  assert.match(popup, /request\.confirmed === true/);
});
