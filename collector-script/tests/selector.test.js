import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSelector } from '../src/utils/helpers.js';

// Minimal DOM stand-ins: `children` wires the sibling index, `shadowRoot`
// makes an element a shadow host so getRootNode() can return it.
function el(tag, { id = '', attrs = {}, children = [] } = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    getAttribute: (key) => (key in attrs ? attrs[key] : null),
    parentElement: null,
    parentNode: null,
    children: [],
    getRootNode() {
      let current = this;
      while (current.parentElement) current = current.parentElement;
      return current.__shadowRoot || current;
    },
  };
  for (const child of children) adopt(node, child);
  return node;
}

function adopt(parent, child) {
  child.parentElement = parent;
  child.parentNode = parent;
  parent.children.push(child);
}

// Puts `tree` inside `host`'s shadow root: the tree's top element keeps no
// parentElement, exactly like a real shadow root's child.
function attachShadow(host, tree) {
  const root = { host, nodeType: 11 };
  let top = tree;
  while (top.parentElement) top = top.parentElement;
  top.__shadowRoot = root;
  return host;
}

test('crosses the shadow boundary instead of stopping at the slot', () => {
  // The Blip Desk shape: <bds-navbar> hosts a shadow tree whose button is the
  // real control. Climbing by parentElement alone yielded `span > slot`.
  const button = el('button', { id: 'change-status-online' });
  const span = el('span', { children: [button] });
  const navbar = el('bds-navbar', { id: 'navbar' });
  attachShadow(navbar, span);

  const selector = generateSelector(button);
  assert.equal(selector, 'button#change-status-online');

  // An id stops the walk, so take a node without one to see the crossing.
  const plain = el('button');
  const wrapper = el('span', { children: [plain] });
  attachShadow(navbar, wrapper);
  assert.equal(generateSelector(plain), 'bds-navbar#navbar >>> span > button');
});

test('prefers stable attributes over a positional index', () => {
  const target = el('button', { attrs: { 'data-testid': 'submit' } });
  const sibling = el('button');
  const form = el('form', { id: 'checkout', children: [sibling, target] });
  assert.equal(generateSelector(target), 'form#checkout > button[data-testid="submit"]');

  // Without a stable attribute the positional fallback still applies.
  assert.equal(generateSelector(sibling), 'form#checkout > button:nth-child(1)');
});

test('falls back to the positional path and respects maxDepth', () => {
  const leaf = el('span');
  const inner = el('div', { children: [leaf] });
  const outer = el('section', { children: [inner] });
  el('body', { children: [outer] });

  assert.equal(generateSelector(leaf), 'body > section > div > span');
  assert.equal(generateSelector(leaf, 2), 'div > span');
  assert.equal(generateSelector(null), '');
  assert.equal(generateSelector(leaf, 0), '');
});

test('escapes quotes inside a stable attribute value', () => {
  const target = el('button', { attrs: { 'aria-label': 'Diga "oi"' } });
  el('div', { id: 'root', children: [target] });
  assert.equal(generateSelector(target), 'div#root > button[aria-label="Diga \\"oi\\""]');
});
