import { defineConfig } from 'vite';
import serveStatic from 'serve-static';
import { resolve } from 'node:path';

export default defineConfig({
  define: {
    __VOIDR_COLLECTOR_URL__: JSON.stringify(
      process.env.VOIDR_COLLECTOR_URL || 'https://collector.voidr.co'
    ),
  },
  server: {
    cors: true,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  plugins: [
    {
      name: 'serve-dist',
      configureServer(server) {
        server.middlewares.use(
          '/dist',
          serveStatic(resolve(process.cwd(), 'dist'), {
            setHeaders(res) {
              res.setHeader('Access-Control-Allow-Origin', '*');
            },
          }),
        );
      },
    },
  ],
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'rrwebClient',
      formats: ['iife'],
      fileName: () => 'recorder.min.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'es2018',
    sourcemap: false,
  },
});
