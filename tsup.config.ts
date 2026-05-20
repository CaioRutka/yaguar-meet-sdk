import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
  },
  {
    entry: { 'server/index': 'src/server/index.ts' },
    outDir: 'dist',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
  },
  {
    entry: { 'client/index': 'src/client/index.ts' },
    outDir: 'dist',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'es2022',
    platform: 'browser',
  },
  {
    entry: { 'shared/index': 'src/shared/index.ts' },
    outDir: 'dist',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'es2022',
    platform: 'neutral',
  },
]);
