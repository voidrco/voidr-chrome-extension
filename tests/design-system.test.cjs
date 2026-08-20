const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('popup and recording overlays consume the packaged Voidr token contract', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const popup = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
  const popupCss = fs.readFileSync(path.join(root, 'popup/popup.css'), 'utf8');
  const contentCss = fs.readFileSync(path.join(root, 'content/content.css'), 'utf8');
  const tokenCss = fs.readFileSync(path.join(root, 'shared/voidr-design-system.css'), 'utf8');
  const contentJs = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background/background.js'), 'utf8');
  const popupJs = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  const sidepanel = fs.readFileSync(path.join(root, 'sidepanel/src/app.tsx'), 'utf8');
  const verificationController = fs.readFileSync(
    path.join(root, 'sidepanel/src/verification-controller.tsx'),
    'utf8',
  );

  assert.match(tokenCss, /Contract: voidr-ds\/2026-08-01/);
  assert.match(tokenCss, /--chartreuse-light:/);
  assert.match(tokenCss, /--burnt-sienna-light:/);
  assert.match(tokenCss, /--shadow-menu:\s*0 10px 30px/);
  assert.match(popup, /shared\/voidr-design-system\.css/);
  assert.match(
    background,
    /css:\s*\['shared\/voidr-design-system\.css',\s*'content\/content\.css'\]/,
  );
  assert.equal(
    manifest.content_scripts.some((script) => script.matches.includes('<all_urls>')),
    false,
    'recording UI must be registered only after runtime host permission is granted',
  );
  for (const [surface, css] of [
    ['popup', popupCss],
    ['content', contentCss],
  ]) {
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${surface} contains a raw color`);
    assert.doesNotMatch(css, /(?:linear|radial)-gradient\(/i, `${surface} contains a gradient`);
  }
  assert.doesNotMatch(contentJs, /[⌖▱▣]/, 'recording chrome must use Lucide, not glyph icons');
  assert.doesNotMatch(
    contentJs,
    /aria-label="Cancelar anotação">×</,
    'annotation close action must use the shared icon system',
  );
  assert.match(contentJs, /voidrIcon\('Activity', 14\)/);
  assert.match(contentJs, /voidrIcon\('MessageSquare', 14\)/);
  assert.match(contentJs, /chrome\.runtime\.getURL\('assets\/logo-light\.svg'\)/);
  assert.match(contentJs, /voidr-loop-launch-brand[\s\S]{0,240}alt="Voidr"/);
  assert.doesNotMatch(contentJs, /voidr-handoff-brand[^`]*<span>[vV]<\/span>/);
  assert.match(contentJs, /voidr-handoff-brand[\s\S]{0,240}alt="Voidr"/);
  assert.match(sidepanel, /chrome\.runtime\.getURL\('assets\/logo-light\.svg'\)/);
  assert.match(verificationController, /chrome\.runtime\.getURL\('assets\/logo-light\.svg'\)/);
  assert.doesNotMatch(sidepanel, /function VoidrLogo\(\)[\s\S]{0,400}<svg/);
  assert.doesNotMatch(verificationController, />\s*V\s*</);
  assert.match(
    contentCss,
    /\.voidr-rec-brand[\s\S]*border-right:\s*1px solid var\(--border-color-subtle\)/,
  );
  assert.match(contentCss, /max-width:\s*640px[\s\S]*\.voidr-rec-brand[\s\S]*width:\s*25px/);
  assert.match(popupJs, /getIcon\('Activity', 24, 1\.5\)/);
  assert.equal(
    (contentJs.match(/<svg\b/g) || []).length,
    1,
    'only the approved inline Voidr brand mark may bypass the packaged Lucide registry',
  );
  assert.doesNotMatch(popupJs, /<svg\b/, 'popup iconography must use the packaged Lucide registry');
  assert.match(popupCss, /\.btn-primary[\s\S]*background:\s*var\(--hover-color-strong\)/);
  assert.match(contentCss, /button:focus-visible/);
  assert.match(popupCss, /button:focus-visible/);
  assert.match(contentCss, /prefers-reduced-motion:\s*reduce/);
  assert.match(popupCss, /prefers-reduced-motion:\s*reduce/);
});
