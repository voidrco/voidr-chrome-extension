import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { state, resetState } = await import('../src/state.js');
const { inlineUnreadableStylesheets } = await import('../src/assets/inline-stylesheets.js');
const { inlineIconFonts } = await import('../src/assets/inline-fonts.js');

function createNode() {
  const attributes = new Map();
  return {
    attributes,
    textContent: '',
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) || null,
    removeAttribute: (name) => attributes.delete(name),
    remove() {},
  };
}

function createDocument(styleSheets = []) {
  const nodes = [];
  const append = (node) => nodes.push(node);
  return {
    baseURI: 'https://app.test/',
    styleSheets,
    head: { appendChild: append },
    documentElement: { appendChild: append },
    createElement: createNode,
    querySelector: (selector) =>
      nodes.find((node) =>
        selector === '[data-voidr-inlined-fonts]'
          ? node.attributes.has('data-voidr-inlined-fonts')
          : false,
      ) || null,
    nodes,
  };
}

const waitForAbort = (_, { signal }) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));

beforeEach(() => {
  resetState();
  state.forceStop = false;
  state.isPaused = false;
  globalThis.window = { location: { origin: 'https://app.test', href: 'https://app.test/' } };
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.fetch;
  resetState();
});

test('asset inlining is disabled by default', async () => {
  let fetchCalls = 0;
  globalThis.document = createDocument();
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('');
  };

  assert.equal(await inlineUnreadableStylesheets(), 0);
  assert.equal(await inlineIconFonts(), 0);
  assert.equal(fetchCalls, 0);
});

test('aborting a stylesheet fetch prevents late DOM injection', async () => {
  const owner = createNode();
  const inserted = [];
  owner.parentNode = { insertBefore: (node) => inserted.push(node) };
  const sheet = { href: 'https://cdn.test/app.css', ownerNode: owner };
  Object.defineProperty(sheet, 'cssRules', {
    get: () => {
      throw new Error('opaque');
    },
  });
  globalThis.document = createDocument([sheet]);
  globalThis.fetch = waitForAbort;
  state.config.inlineStylesheets = true;
  const controller = new AbortController();

  const result = inlineUnreadableStylesheets(
    state.lifecycleId,
    controller.signal,
    Date.now() + 500,
  );
  controller.abort();

  assert.equal(await result, 0);
  assert.equal(inserted.length, 0);
  assert.equal(owner.getAttribute('data-voidr-css-inlined'), null);
});

test('font inlining deduplicates its injected style', async () => {
  const values = {
    src: "url('/icon.woff2')",
    'font-family': 'Icons',
    'font-weight': '400',
    'font-style': 'normal',
    'unicode-range': '',
  };
  const rule = { type: 5, style: { getPropertyValue: (name) => values[name] || '' } };
  const sheet = { href: 'https://app.test/app.css', cssRules: [rule] };
  globalThis.document = createDocument([sheet]);
  globalThis.fetch = async () => new Response(new Uint8Array(64), { status: 200 });
  state.config.inlineFonts = true;

  assert.equal(await inlineIconFonts(), 1);
  assert.equal(await inlineIconFonts(), 0);
  assert.equal(document.nodes.length, 1);
  assert.equal(state.inlinedAssetNodes.length, 1);
});
