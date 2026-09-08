import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Test configuration, kept separate from `vite.config.ts` so the production
 * build never has to load the test runner's plugins.
 *
 * These are pure-logic tests: plan geometry, document validation and schema
 * migration. They need no browser and no GPU, so they run in a couple of
 * seconds and are safe to gate the deploy on.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
