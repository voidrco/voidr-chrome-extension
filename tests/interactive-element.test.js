import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInteractiveElement,
  resolveInteractiveTarget,
  getAccessibleLabel,
  nameFromHref,
} from '../src/utils/interactive-element.js';

function el(tag, { attrs = {}, text = '' } = {}) {
  return {
    tagName: tag.toUpperCase(),
    textContent: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelector: () => null,
  };
}

test('isInteractiveElement: structural checks', () => {
  assert.equal(isInteractiveElement(el('button')), true);
  assert.equal(isInteractiveElement(el('a', { attrs: { href: '/x' } })), true);
  assert.equal(isInteractiveElement(el('a')), false); // anchor without href
  assert.equal(isInteractiveElement(el('input', { attrs: { type: 'text' } })), true);
  assert.equal(isInteractiveElement(el('input', { attrs: { type: 'hidden' } })), false);
  assert.equal(isInteractiveElement(el('div', { attrs: { role: 'menuitem' } })), true);
  assert.equal(isInteractiveElement(el('div', { attrs: { 'data-testid': 'cta' } })), true);
  assert.equal(isInteractiveElement(el('svg')), false);
  assert.equal(isInteractiveElement(null), false);
});

test('resolveInteractiveTarget: climbs from icon leaf to the real control', () => {
  // click on nav > a[href] > span > svg — composedPath is deepest-first
  const path = [
    el('svg'),
    el('span'),
    el('a', { attrs: { href: '/notification-templates/' } }),
    el('nav'),
    el('body'),
  ];
  const resolved = resolveInteractiveTarget(path);
  assert.equal(resolved.tagName, 'A');
  assert.equal(resolved.getAttribute('href'), '/notification-templates/');
});

test('resolveInteractiveTarget: stops at body and respects maxDepth', () => {
  const deep = [el('svg'), el('span'), el('body'), el('a', { attrs: { href: '/after-body' } })];
  assert.equal(resolveInteractiveTarget(deep), null);

  const path = [
    el('i'), el('i'), el('i'),
    el('a', { attrs: { href: '/deep' } }),
  ];
  assert.equal(resolveInteractiveTarget(path, 3), null);
  assert.equal(resolveInteractiveTarget(path, 4)?.getAttribute('href'), '/deep');
});

test('resolveInteractiveTarget: tolerates non-element entries (text nodes, window)', () => {
  const path = [{}, null, el('a', { attrs: { href: '/x' } })];
  assert.equal(resolveInteractiveTarget(path)?.getAttribute('href'), '/x');
  assert.equal(resolveInteractiveTarget(null), null);
});

test('getAccessibleLabel: priority chain', () => {
  assert.equal(
    getAccessibleLabel(el('a', { attrs: { 'aria-label': 'Monitor' }, text: 'ignored' })),
    'Monitor',
  );
  assert.equal(getAccessibleLabel(el('a', { text: '  Templates  de \n Notificação ' })), 'Templates de Notificação');
  assert.equal(getAccessibleLabel(el('a', { attrs: { title: 'Dica' } })), 'Dica');
  assert.equal(
    getAccessibleLabel(el('a', { attrs: { href: '/notification-templates/' } })),
    'notification-templates',
  );
  assert.equal(getAccessibleLabel(el('svg')), '');
});

test('nameFromHref: edge cases', () => {
  assert.equal(nameFromHref('/notification-templates/'), 'notification-templates');
  assert.equal(nameFromHref('/monitor?view=products'), 'monitor');
  assert.equal(nameFromHref('https://app.example.com/execution/history/'), 'history');
  assert.equal(nameFromHref('/'), null);
  assert.equal(nameFromHref('#'), null);
  assert.equal(nameFromHref('#section'), null);
  assert.equal(nameFromHref('javascript:void(0)'), null);
  assert.equal(nameFromHref('mailto:x@y.co'), null);
  assert.equal(nameFromHref('/caminho/com%20espa%C3%A7o'), 'com espaço');
  assert.equal(nameFromHref(''), null);
  assert.equal(nameFromHref(null), null);
});
