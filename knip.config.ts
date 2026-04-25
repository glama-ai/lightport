import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: ['src/index.ts'],
  project: ['src/**/*.ts'],
  ignoreDependencies: ['pino-pretty'],
  ignoreExportsUsedInFile: true,
};

export default config;
