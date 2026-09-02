import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  base: './',
  clearScreen: false,
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: false,
  },
  worker: {
    format: 'es',
  },
  esbuild: {
    legalComments: 'none',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    cssCodeSplit: true,
    minify: 'esbuild',
    sourcemap: true,
    reportCompressedSize: false,
    modulePreload: {
      polyfill: false,
    },
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
