import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Built output is loaded straight by the extension manifest
// (side_panel.default_path = sidepanel/dist/index.html), so asset URLs must be
// relative — hence base: ''.
export default defineConfig({
  base: '',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    // playwright-crx alone is ~5.4MB; the warning is expected and accepted.
    chunkSizeWarningLimit: 7000,
    sourcemap: false,
  },
});
