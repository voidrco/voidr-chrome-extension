const test = require('node:test');
const assert = require('node:assert/strict');
const { stateFromDelivery, viewModel } = require('../shared/verification-handoff-ux.js');

test('receipt copy is emitted only after a real acknowledged delivery', () => {
  const available = viewModel('available', { displayName: 'Cursor', provider: 'cursor' });
  assert.equal(available.title, 'Contexto disponível para Cursor');
  assert.equal(available.truthfulReceipt, false);
  assert.doesNotMatch(available.title, /Recebido/);

  const acknowledged = viewModel('acknowledged', {
    displayName: 'Cursor',
    provider: 'cursor',
  });
  assert.equal(acknowledged.title, 'Recebido pelo Cursor');
  assert.equal(acknowledged.truthfulReceipt, true);
});

test('working states use factual compact stages and mapped harness name', () => {
  const view = viewModel('context', { displayName: 'Cursor', provider: 'cursor' });
  assert.equal(view.title, 'Preparando contexto para Cursor');
  assert.deepEqual(
    view.steps.map((step) => step.label),
    [
      'Consolidando requisições',
      'Consolidando cliques',
      'Organizando snapshots e anotações',
      'Contexto para Cursor',
    ],
  );
});

test('delivery state projection never treats an available context as acknowledged', () => {
  assert.equal(stateFromDelivery({ state: 'available' }, false), 'available');
  assert.equal(stateFromDelivery({ state: 'acknowledged' }, false), 'acknowledged');
  assert.equal(stateFromDelivery(null, true), 'pending');
  assert.equal(stateFromDelivery({ state: 'preparing' }, false), 'pending');
});

test('product-native cycles finish in Voidr without inventing a harness delivery', () => {
  const ready = viewModel('product_ready', null, { cycleNumber: 3 });
  assert.equal(ready.title, 'Ciclo pronto para revisar');
  assert.equal(ready.harness.connected, false);
  assert.equal(ready.steps.at(-1).label, 'Publicando ciclo na Voidr');
  assert.doesNotMatch(JSON.stringify(ready), /seu harness|Cursor|Recebido pelo/);
});
