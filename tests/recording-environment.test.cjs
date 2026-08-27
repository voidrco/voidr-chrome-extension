const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const content = readFileSync('content/content.js', 'utf8');
const popup = readFileSync('popup/popup.js', 'utf8');

test('recording code environment reaches collector init', () => {
  assert.match(popup, /environmentSlug: recordingCodeContext\.environmentSlug/);
  assert.match(content, /environmentSlug: request\.environmentSlug/);
  assert.match(content, /environmentSlug: options\.environmentSlug/);
  assert.match(content, /initOptions\.environment = init\.environmentSlug/);
});
