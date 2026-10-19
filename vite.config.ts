import { defineConfig, type Plugin } from 'vite';

// ez-tree's npm build inlines its 20 bark and leaf images (~4 MB of base64, most of the page's script) and starts
// loading them all when its module loads; the demo takes only its geometry (its own textures are in public/textures).
// So the package's source is bundled instead (it ships in the package), its textures module swapped for one that
// loads nothing (the materials ez-tree builds get no maps; nothing draws them).
const EZ_TREE = 'node_modules/@dgreenheck/ez-tree/src/lib/';
function ezTreeWithoutTextures(): Plugin {
  return {
    name: 'ez-tree-without-textures',
    enforce: 'pre',
    load(id) {
      if (id.replace(/\\/g, '/').endsWith(`${EZ_TREE}textures.js`)) return 'export const getBarkTexture = () => null;\nexport const getLeafTexture = () => null;\n';
    },
  };
}

export default defineConfig({
  base: './', // relative asset paths so dist/ works under the GitHub Pages subpath
  plugins: [ezTreeWithoutTextures()],
  resolve: {
    alias: [
      { find: /^@dgreenheck\/ez-tree$/, replacement: `/${EZ_TREE}index.js` },
      // (ez-tree imports 'three', in the DAG worker where it grows the trees: three's core from source, so only the
      // classes it uses are bundled; the build, with the WebGL renderer, made a ~1 MB worker)
      { find: /^three$/, replacement: 'three/src/Three.Core.js' },
    ],
  },
  worker: { format: 'es', plugins: () => [ezTreeWithoutTextures()] }, // (ez-tree grows in the DAG worker)
  build: { target: 'es2022' },
  // (the harness's scratch and output: browser profiles left by hung runs are ~100k files, and watching them held
  // up the dev server's first requests for minutes)
  server: { watch: { ignored: ['**/tools/tmp/**', '**/tools/out/**'] } },
});
