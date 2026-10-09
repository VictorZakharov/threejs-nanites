// Command line of tools/harness.mjs: `--name=value` or `--flag`, nothing positional.
import { VIEWS, DEFAULT_VIEWS } from './views.mjs';

export const HELP = `Nanite Forest harness: headless benchmark, screenshots and probes (results in tools/out/)

  npm run harness                                  the default views, default settings
  npm run harness -- --views=ground,canopy --frames=200 --query="shadows=0&trees=5000"
  npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/   the deployed site instead

views and settings
  --views=a,b        viewpoints from tools/harness/views.mjs (default: ${DEFAULT_VIEWS.join(',')})
  --query=k=v&...    URL parameters of the demo (see README)
  --zoom=5           look through the right-mouse zoom
  --size=1600x900    viewport;  --frames=120 benchmark frames per view;  --no-shots  skip screenshots

measuring
  --probe=a,b        run tools/probes/<name>.js after each view and print what it returns (a \`png\` data URL in it
                     is saved as tools/out/<probe>-<view>.png); see tools/probes/README.md
  --ab="q1|q2"       every view under each query (on top of --query): numbers, screenshots <view>@<k>.png and
                     mean colours (all pixels / tree pixels) per variant
  --sweep=lod,shadowlod,shadow   hold the view, move only the LOD reference / shadow-caster LOD reference /
                     shadow-map centre (--steps=30 --step=3 m); counts brightness jumps, heatmap sweep-<what>-<view>.png
  --dolly            move the camera in small steps (--steps=40 --step=0.5 m); counts tiles that flicker,
                     heatmap dolly-<view>.png
  --flicker          a still camera must render identical frames (use --query=wind=0)
  --eval="expr"      evaluate an expression in the page once after loading;  --eval-file=path  the same from a file

loading
  --loading-shots    screenshots of the loading screen;  --resize-during-load=1280x1000  resize while loading
  --verbose          echo the whole page console

image tools: node tools/img.mjs (colour stats and enlarged crops of screenshots)`;

/** Parses process.argv into the harness's options. */
export function parseOptions(argv) {
  const args = Object.fromEntries(
    argv.map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
  );
  const [width, height] = String(args.size ?? '1600x900').split('x').map(Number);
  const views = args.views ? String(args.views).split(',') : DEFAULT_VIEWS;
  const unknown = views.filter((v) => !VIEWS[v]);
  if (unknown.length) throw new Error(`unknown view(s): ${unknown.join(', ')} (see tools/harness/views.mjs)`);
  return {
    help: Boolean(args.help || args.h),
    width,
    height,
    frames: Number(args.frames ?? 120),
    query: String(args.query ?? ''),
    views,
    zoom: Number(args.zoom ?? 1),
    url: args.url ? String(args.url) : null,
    shots: !args['no-shots'],
    probes: args.probe ? String(args.probe).split(',') : [],
    variants: args.ab ? String(args.ab).split('|') : null,
    sweep: args.sweep ? String(args.sweep).split(',') : null,
    dolly: Boolean(args.dolly),
    steps: args.steps ? Number(args.steps) : null,
    step: args.step ? Number(args.step) : null,
    flicker: Boolean(args.flicker),
    eval: args.eval ? String(args.eval) : null,
    evalFile: args['eval-file'] ? String(args['eval-file']) : null,
    loadingShots: Boolean(args['loading-shots']),
    resizeDuringLoad: args['resize-during-load'] ? String(args['resize-during-load']).split('x').map(Number) : null,
    verbose: Boolean(args.verbose),
  };
}
