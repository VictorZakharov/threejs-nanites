import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset paths so dist/ works under the GitHub Pages subpath
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
