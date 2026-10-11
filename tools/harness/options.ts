// Command line of tools/harness.ts: `--name=value` or `--flag`, nothing positional.
import { VIEWS, DEFAULT_VIEWS } from './views.ts';

export const HELP = `Nanite Forest harness: headless benchmark, screenshots and probes (results in tools/out/)

  npm run harness                                  the default views, default settings
  npm run harness -- --views=ground,canopy --frames=200 --query="shadows=0&trees=5000"
  npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/   the deployed site instead

views and settings
  --views=a,b        viewpoints from tools/harness/views.ts (default: ${DEFAULT_VIEWS.join(',')})
  --query=k=v&...    URL parameters of the demo (see README)
  --zoom=5           look through the right-mouse zoom (default: the view's own, else 1)
  --size=1600x900    viewport;  --frames=120 benchmark frames per view;  --no-shots  skip screenshots

measuring
  --probe=a,b        run tools/probes/<name>.ts after each view and print what it returns (a \`png\` data URL in it
                     is saved as tools/out/<probe>-<view>.png); see tools/probes/README.md
  --ab="q1|q2"       every view under each query (on top of --query): numbers, screenshots <view>@<k>.png and
                     mean colours (all pixels / tree pixels) per variant
  --sweep=lod,shadowlod,shadow   hold the view, move only the LOD reference / shadow-caster LOD reference /
                     shadow-map centre (--steps=30 --step=3 m); counts brightness jumps, heatmap sweep-<what>-<view>.png
  --dolly            move the camera in small steps (--steps=40 --step=0.5 m); counts tiles that flicker,
                     heatmap dolly-<view>.png
  --turn=DEG         --dolly: also turn the camera this many degrees (yaw) per step (mouse look; --step=0 to only turn)
  --rise=M           --dolly: also climb this many metres per step (negative: descend)
  --rect=x,y,w,h     --dolly: count only the tiles inside this screen rectangle (e.g. the distant treeline)
  --timeout=N        give up after N seconds, naming the step it was in. Default: what the run should take
                     (30 s + 8 s per view and variant + 1 s per sweep/dolly step), so a stuck run fails fast
  --typematch        per tree type: coverage and colour of the real trees vs the impostors, and the colour gain
                     that would match them (see harness/typematch.ts)
  --typematch=calibrate   adjust the impostor gains in the page until they match (views looking down steeply
                     calibrate the top-down gains, others the side gains), print values for src/trees.ts
  --flicker          a still camera must render identical frames (use --query=wind=0)
  --eval="expr"      evaluate an expression in the page once after loading;  --eval-file=path  the same from a file

loading
  --loading-shots    screenshots of the loading screen;  --resize-during-load=1280x1000  resize while loading
  --verbose          echo the whole page console

image tools: node tools/img.ts (colour stats and enlarged crops of screenshots)`;

/** Parses process.argv into the harness's options. */
export function parseOptions(argv: string[]) {
  const args = Object.fromEntries(
    argv.map((a): [string, string | true] => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
  );
  const [width, height] = String(args.size ?? '1600x900').split('x').map(Number);
  const views = args.views ? String(args.views).split(',') : DEFAULT_VIEWS;
  const unknown = views.filter((v) => !VIEWS[v]);
  if (unknown.length) throw new Error(`unknown view(s): ${unknown.join(', ')} (see tools/harness/views.ts)`);
  const base = {
    help: Boolean(args.help || args.h),
    width,
    height,
    frames: Number(args.frames ?? 120),
    query: String(args.query ?? ''),
    views,
    zoom: args.zoom === undefined ? undefined : Number(args.zoom), // (unset: the view's own zoom, else 1)
    url: args.url ? String(args.url) : null,
    shots: !args['no-shots'],
    probes: args.probe ? String(args.probe).split(',') : [],
    variants: args.ab ? String(args.ab).split('|') : null,
    sweep: args.sweep ? String(args.sweep).split(',') : null,
    dolly: Boolean(args.dolly),
    turn: args.turn ? Number(args.turn) : 0,
    rise: args.rise ? Number(args.rise) : 0,
    rect: args.rect ? String(args.rect).split(',').map(Number) : null,
    typematch: args.typematch ? (args.typematch === 'calibrate' ? 'calibrate' : 'measure') : null,
    timeout: args.timeout === undefined ? null : Number(args.timeout), // (null: expectedSeconds, see below)
    steps: args.steps ? Number(args.steps) : null,
    step: args.step !== undefined ? Number(args.step) : null,
    flicker: Boolean(args.flicker),
    eval: args.eval ? String(args.eval) : null,
    evalFile: args['eval-file'] ? String(args['eval-file']) : null,
    loadingShots: Boolean(args['loading-shots']),
    resizeDuringLoad: args['resize-during-load'] ? String(args['resize-during-load']).split('x').map(Number) : null,
    verbose: Boolean(args.verbose),
  };
  return { ...base, timeout: base.timeout ?? expectedSeconds(base) };
}

/** The harness's options (see HELP). */
export type Options = ReturnType<typeof parseOptions>;

/** A generous estimate of a run's wall time (a basic two-view run takes ~20 s), for the watchdog. */
function expectedSeconds(o: { views: string[]; variants: string[] | null; sweep: string[] | null; dolly: boolean; steps: number | null; typematch: string | null }): number {
  const runs = o.views.length * (o.variants?.length ?? 1);
  const steps = ((o.sweep?.length ?? 0) + (o.dolly ? 1 : 0)) * (o.steps ?? 40) + (o.typematch ? 30 : 0);
  return Math.round(30 + runs * (8 + steps));
}
