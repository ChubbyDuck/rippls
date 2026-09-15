import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '~': src,
    },
  },
  // Fresh installs float platform-node-shared past the pinned effect RC.
  ssr: {
    noExternal: ['@effect/platform-node', '@effect/platform-node-shared'],
  },
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'rippls.js',
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
