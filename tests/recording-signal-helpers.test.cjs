const test = require('node:test');
const assert = require('node:assert/strict');

const signals = require('../shared/recording-signal-helpers.js');

test('capture signal summary starts honest and increments only known signals', () => {
  const state = signals.create('http://localhost:8080/checkout');
  assert.deepEqual(signals.snapshot(state), {
    pages: 1,
    clicks: 0,
    requests: 0,
    errors: 0,
    notes: 0,
    voiceNotes: 0,
  });
  signals.increment(state, 'clicks', 2);
  signals.increment(state, 'requests', 3);
  signals.increment(state, 'unknown', 99);
  assert.equal(state.clicks, 2);
  assert.equal(state.requests, 3);
  assert.equal(state.unknown, undefined);
});

test('navigation counts only actual URL changes', () => {
  const state = signals.create('https://app.voidr.co/a');
  signals.observeUrl(state, 'https://app.voidr.co/a');
  signals.observeUrl(state, 'https://app.voidr.co/b');
  signals.observeUrl(state, 'https://app.voidr.co/b');
  assert.equal(state.pages, 2);
  assert.equal(state.lastUrl, 'https://app.voidr.co/b');
});
