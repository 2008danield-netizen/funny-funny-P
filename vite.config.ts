import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite configuration for havavamama.
 *
 * `base` matters for GitHub Pages: the site is served from
 * https://<user>.github.io/<repo>/ rather than from the domain root, so every
 * asset URL needs that prefix.
 *
 * It is applied in development and preview too, not just in production builds.
 * Scoping it to builds alone is the usual advice, but it makes `npm run preview`
 * serve a page whose asset URLs 404 — the dist/index.html asks for
 * /<repo>/assets/... while the preview server roots itself at /. Keeping one
 * base everywhere costs a longer dev URL and buys a preview that is byte-for-byte
 * what GitHub Pages will serve.
 *
 * If havavamama later moves to its own domain (or a custom CNAME on Pages),
 * change this to '/'.
 */
const BASE_PATH = '/VR-home-design-project/';

export default defineConfig(() => ({
  plugins: [react()],

  base: BASE_PATH,

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // Three.js is large and rarely changes; splitting it out means edits to our
    // own code do not force users to re-download the whole engine.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },

  server: {
    host: true,
    port: 5173,
  },
}));
