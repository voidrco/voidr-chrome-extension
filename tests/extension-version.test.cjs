const assert = require('node:assert/strict');
const { test } = require('node:test');

test('Chrome versions compare as four numeric components', async () => {
  const { compareChromeVersions } = await import('../scripts/extension-version.mjs');

  assert.equal(compareChromeVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareChromeVersions('1.0', '1.0.0.0'), 0);
  assert.equal(compareChromeVersions('1.0.5', '1.0.5.1'), -1);
});

test('invalid Chrome versions are rejected', async () => {
  const { parseChromeVersion } = await import('../scripts/extension-version.mjs');

  for (const version of ['0', '1.02', '1.2.3.4.5', '1.65536']) {
    assert.throws(() => parseChromeVersion(version), /Invalid Chrome extension version/);
  }
});

test('only production package paths require a version bump', async () => {
  const { requiresVersionBump } = await import('../scripts/extension-version.mjs');

  assert.equal(requiresVersionBump(['background/background.js']), true);
  assert.equal(requiresVersionBump(['manifest.json']), true);
  assert.equal(
    requiresVersionBump(['README.md', 'package.json', 'tests/auth-token-guard.test.cjs']),
    false,
  );
  assert.equal(requiresVersionBump(['config/env.local.example.js']), false);
});

test('store publication is idempotent and never replaces an active review', async () => {
  const { releaseDisposition } = await import('../scripts/chrome-web-store-release.mjs');

  assert.deepEqual(
    releaseDisposition(
      {
        publishedItemRevisionStatus: {
          state: 'PUBLISHED',
          distributionChannels: [{ crxVersion: '1.0.5' }],
        },
      },
      '1.0.5',
    ),
    { action: 'skip', reason: 'Version 1.0.5 is already published.' },
  );

  assert.equal(
    releaseDisposition(
      {
        publishedItemRevisionStatus: {
          state: 'PUBLISHED',
          distributionChannels: [{ crxVersion: '1.0.5' }],
        },
        submittedItemRevisionStatus: {
          state: 'PENDING_REVIEW',
          distributionChannels: [{ crxVersion: '1.0.6' }],
        },
      },
      '1.0.7',
    ).action,
    'blocked',
  );

  assert.deepEqual(releaseDisposition({}, '1.0.6'), { action: 'publish' });
});
