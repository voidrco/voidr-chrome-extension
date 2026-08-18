import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.__VOIDR_COLLECTOR_URL__ = 'https://collector.test';

const { absolutizeCssUrls, inlineCssImports } = await import('../src/assets/inline-stylesheets.js');

describe('absolutizeCssUrls', () => {
  const base = 'https://cdn.example.com/assets/css/app.css';

  it('rewrites relative url() references against the sheet URL', () => {
    const css = '.icon { background: url(../img/icon.png); }';
    assert.equal(
      absolutizeCssUrls(css, base),
      '.icon { background: url(https://cdn.example.com/assets/img/icon.png); }',
    );
  });

  it('rewrites quoted urls and @import while preserving quotes', () => {
    const css = `@import "reset.css";\n.a { src: url('fonts/x.woff2'); }`;
    const out = absolutizeCssUrls(css, base);
    assert.ok(out.includes('@import "https://cdn.example.com/assets/css/reset.css"'));
    assert.ok(out.includes("url('https://cdn.example.com/assets/css/fonts/x.woff2')"));
  });

  it('leaves absolute, data:, blob: and fragment urls untouched', () => {
    const css =
      '.a { background: url(https://other.com/a.png); mask: url(#clip); ' +
      'src: url(data:font/woff2;base64,AAAA); content: url(blob:x); }';
    assert.equal(absolutizeCssUrls(css, base), css);
  });
});

describe('inlineCssImports', () => {
  const base = 'https://cdn.example.com/assets/css/app.css';
  const sheets = {
    'https://cdn.example.com/assets/css/reset.css': {
      text: 'body { margin: 0; }',
      baseUrl: 'https://cdn.example.com/assets/css/reset.css',
    },
    'https://cdn.example.com/assets/css/theme.css': {
      // Nested import + a relative ref that must be absolutized against the
      // IMPORTED sheet's own URL, not the importer's.
      text: '@import "reset.css";\n.t { background: url(img/t.png); }',
      baseUrl: 'https://cdn.example.com/assets/css/theme.css',
    },
    // Simulates a redirect: requested at /moved.css, served from /v2/real.css.
    'https://cdn.example.com/assets/css/moved.css': {
      text: '.m { background: url(m.png); }',
      baseUrl: 'https://cdn.example.com/assets/v2/real.css',
    },
  };
  const fakeFetch = async (url) => sheets[url] || null;

  it('inlines @import (url and string forms) with the sheet text', async () => {
    const css = '@import url("reset.css"); .x { color: red; }';
    const out = await inlineCssImports(css, base, undefined, 0, fakeFetch);
    assert.ok(!out.includes('@import'));
    assert.ok(out.includes('body { margin: 0; }'));
    assert.ok(out.includes('.x { color: red; }'));
  });

  it('inlines nested imports recursively and absolutizes refs against each sheet', async () => {
    const css = '@import "theme.css";';
    const out = await inlineCssImports(css, base, undefined, 0, fakeFetch);
    assert.ok(!out.includes('@import'));
    assert.ok(out.includes('body { margin: 0; }')); // nested reset.css
    assert.ok(out.includes('url(https://cdn.example.com/assets/css/img/t.png)'));
  });

  it('wraps the inlined text in @media when the import carries a media list', async () => {
    const css = '@import "reset.css" screen and (max-width: 600px);';
    const out = await inlineCssImports(css, base, undefined, 0, fakeFetch);
    assert.ok(out.includes('@media screen and (max-width: 600px) { body { margin: 0; } }'));
  });

  it('uses the POST-REDIRECT response url as base for the imported sheet refs', async () => {
    const css = '@import "moved.css";';
    const out = await inlineCssImports(css, base, undefined, 0, fakeFetch);
    assert.ok(out.includes('url(https://cdn.example.com/assets/v2/m.png)'));
  });

  it('keeps unreachable imports untouched (graceful degradation to absolutize)', async () => {
    const css = '@import "missing.css"; .x { color: red; }';
    const out = await inlineCssImports(css, base, undefined, 0, fakeFetch);
    assert.ok(out.includes('@import "missing.css"'));
  });

  it('stops at the depth cap instead of recursing forever', async () => {
    const selfRef = {
      'https://cdn.example.com/assets/css/loop.css': {
        text: '@import "loop.css"; .loop { color: blue; }',
        baseUrl: 'https://cdn.example.com/assets/css/loop.css',
      },
    };
    const out = await inlineCssImports(
      '@import "loop.css";',
      base,
      undefined,
      0,
      async (url) => selfRef[url] || null,
    );
    // Depth-capped: the innermost @import survives (absolutization handles it).
    assert.ok(out.includes('.loop { color: blue; }'));
  });
});
