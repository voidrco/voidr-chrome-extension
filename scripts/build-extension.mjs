import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!['production', 'debug'].includes(mode)) {
  throw new Error('Usage: node scripts/build-extension.mjs <production|debug>');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const staging = join(dist, mode);
const archive = join(dist, `voidr-extension${mode === 'debug' ? '-debug' : ''}.zip`);
const unpacked = mode === 'debug' ? join(dist, 'voidr-extension-debug-unpacked') : null;

rmSync(staging, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(staging, { recursive: true });

for (const directory of ['assets', 'background', 'content', 'icons', 'popup', 'vendor']) {
  const source = join(root, directory);
  if (existsSync(source)) cpSync(source, join(staging, directory), { recursive: true });
}

mkdirSync(join(staging, 'config'));
for (const file of ['env.js', 'env-local-loader.js']) {
  cpSync(join(root, 'config', file), join(staging, 'config', file));
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (mode === 'debug') {
  manifest.name = `${manifest.name} [DEBUG]`;
  manifest.action.default_title = `${manifest.action.default_title} [DEBUG]`;
  manifest.description = 'Capture user sessions against a configurable Voidr service';
}
writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (unpacked) {
  rmSync(unpacked, { recursive: true, force: true });
  cpSync(staging, unpacked, { recursive: true });
}
execFileSync('zip', ['-qr', archive, '.'], { cwd: staging, stdio: 'inherit' });
rmSync(staging, { recursive: true, force: true });

console.log(`Built ${archive}`);
