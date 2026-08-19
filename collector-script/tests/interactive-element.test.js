import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInteractiveElement,
  isElementVisible,
  isInsideRecorderUi,
  isRecorderUi,
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

  const path = [el('i'), el('i'), el('i'), el('a', { attrs: { href: '/deep' } })];
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
  assert.equal(
    getAccessibleLabel(el('a', { text: '  Templates  de \n Notificação ' })),
    'Templates de Notificação',
  );
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


/** Element whose CSS resolution we control; `styles` is what getComputedStyle returns. */
function styled(tag, { attrs = {}, styles = { visibility: 'visible', display: 'block' } } = {}) {
  const node = el(tag, { attrs });
  node.hidden = false;
  node.ownerDocument = { defaultView: { getComputedStyle: () => styles } };
  return node;
}

test('isElementVisible: reads CSS, never geometry', () => {
  assert.equal(isElementVisible(styled('button')), true);
  assert.equal(isElementVisible(styled('button', { styles: { visibility: 'hidden' } })), false);
  assert.equal(isElementVisible(styled('button', { styles: { display: 'none' } })), false);

  const hiddenAttr = styled('button');
  hiddenAttr.hidden = true;
  assert.equal(isElementVisible(hiddenAttr), false);

  // Nothing to resolve — the filter only subtracts, so it must not guess.
  assert.equal(isElementVisible(el('button')), true);
  assert.equal(isElementVisible(null), true);
});

test('isElementVisible: catches the control a forwarded click lands on', () => {
  // Blip's login draws its own button over Azure B2C's form, which the page
  // hides with `visibility: hidden` on an ancestor — and visibility inherits.
  const hiddenNative = styled('button', {
    attrs: { id: 'next' },
    styles: { visibility: 'hidden', display: 'inline-block' },
  });
  assert.equal(isElementVisible(hiddenNative), false);
});

test('isRecorderUi: the recorder never indexes its own overlay', () => {
  const inPanel = el('button');
  inPanel.closest = (sel) => (sel.includes('voidr-rec-panel') ? {} : null);
  assert.equal(isRecorderUi(inPanel), true);

  const appButton = el('button');
  appButton.closest = () => null;
  assert.equal(isRecorderUi(appButton), false);
  assert.equal(isRecorderUi(null), false);
});

test('isInsideRecorderUi: matches against roots resolved once per scan', () => {
  const button = el('button');
  const panel = { contains: (node) => node === button };
  assert.equal(isInsideRecorderUi(button, [panel]), true);
  assert.equal(isInsideRecorderUi(el('button'), [panel]), false);
  assert.equal(isInsideRecorderUi(button, []), false);
  assert.equal(isInsideRecorderUi(null, [panel]), false);
});
