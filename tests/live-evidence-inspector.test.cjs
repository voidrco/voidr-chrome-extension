const assert = require('node:assert/strict');
const { test } = require('node:test');
const inspector = require('../shared/live-evidence-inspector.js');

test('request presentation communicates status, duration and ownership compactly', () => {
  const presentation = inspector.itemPresentation('requests', {
    method: 'POST',
    url: 'https://app.test/api/checkout?retry=1',
    status: 502,
    durationMs: 2450,
    contentType: 'application/json',
    thirdParty: false,
  });
  assert.equal(presentation.title, '/api/checkout?retry=1');
  assert.equal(presentation.eyebrow, 'POST · 502');
  assert.match(presentation.meta, /2\.5 s/);
  assert.match(presentation.meta, /1st party/);
  assert.equal(presentation.tone, 'danger');
});

test('request detail model keeps diagnostics and causal evidence references', () => {
  const fields = inspector.detailFields('requests', {
    id: 'request-42',
    offsetMs: 1720,
    pageRef: 'pages-1',
    clickRef: 'click-7',
    method: 'PATCH',
    url: 'https://app.test/api/order/42',
    status: 409,
    durationMs: 85,
    requestHeaders: { 'content-type': 'application/json' },
    requestBodyPreview: { retry: true },
    responseBodyPreview: { code: 'VERSION_CONFLICT' },
    traceId: 'trace-42',
  });
  const byLabel = Object.fromEntries(fields.map((field) => [field.label, field.value]));
  assert.equal(byLabel['Evidence ID'], 'request-42');
  assert.equal(byLabel['Página relacionada'], 'pages-1');
  assert.equal(byLabel['Clique relacionado'], 'click-7');
  assert.match(byLabel['Request body · preview seguro'], /retry/);
  assert.match(byLabel['Response body · preview seguro'], /VERSION_CONFLICT/);
});

test('context normalization rejects drift and fills every category safely', () => {
  assert.equal(inspector.normalizeContext({ version: 'UNKNOWN/1' }), null);
  const normalized = inspector.normalizeContext({
    version: inspector.VERSION,
    counts: { requests: 14 },
    categories: { requests: [{ id: 'request-1' }] },
  });
  assert.equal(normalized.counts.requests, 14);
  assert.equal(normalized.counts.errors, 0);
  assert.deepEqual(normalized.categories.errors, []);
});

test('clicks distinguish causal effects from dead-click candidates', () => {
  assert.equal(inspector.effectSummary({ networkMs: 40, mutationMs: 70 }), 'Efeito: request, DOM');
  assert.equal(inspector.effectSummary({}), 'Sem efeito detectado');
  assert.equal(
    inspector.itemPresentation('clicks', { label: 'Salvar', effects: {} }).tone,
    'warning',
  );
});
