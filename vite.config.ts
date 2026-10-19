import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative asset paths so dist/ works under the GitHub Pages subpath
  worker: { format: 'es' },
  build: { target: 'es2022' },
  // (the harness's scratch and output: browser profiles left by hung runs are ~100k files, and watching them held
  // up the dev server's first requests for minutes)
  server: { watch: { ignored: ['**/tools/tmp/**', '**/tools/out/**'] } },
});
