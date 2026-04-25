import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/start-server.ts'],
  outDir: 'build',
  format: 'esm',
  bundle: false,
  clean: true,
});
