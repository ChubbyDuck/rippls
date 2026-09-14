import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '~': src,
    },
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
