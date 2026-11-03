import { defineConfig } from 'vitest/config';
export default defineConfig({
  base: './',
  build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
