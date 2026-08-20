const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../shared/verification-evidence-helpers.js');

test('recognizes only opaque local Verification evidence references', () => {
  assert.equal(helpers.isLocalEvidenceRef('verification-evidence-local:asset_1'), true);
  assert.equal(helpers.isLocalEvidenceRef('verification-crop-local:crop-1'), true);
  assert.equal(helpers.isLocalEvidenceRef('verification-asset:durable'), false);
  assert.equal(helpers.isLocalEvidenceRef('verification-evidence-local:../secret'), false);
});

test('rewrites queued annotations without touching unrelated fields', () => {
  const pending = [
    {
      endpoint: 'annotations',
      input: {
        note: 'Checkout failed',
        screenshotRef: 'verification-evidence-local:asset_1',
        cropRef: 'verification-crop-local:crop_2',
      },
    },
  ];
  const rewritten = helpers.replacePendingEvidenceRef(
    pending,
    'verification-evidence-local:asset_1',
    'verification-asset:durable_1',
  );
  assert.equal(rewritten[0].input.screenshotRef, 'verification-asset:durable_1');
  assert.equal(rewritten[0].input.cropRef, 'verification-crop-local:crop_2');
  assert.equal(rewritten[0].input.note, 'Checkout failed');
  assert.equal(pending[0].input.screenshotRef, 'verification-evidence-local:asset_1');
});
