// Command line of tools/harness.ts: `--name=value` or `--flag`, nothing positional.
import { VIEWS, DEFAULT_VIEWS } from './views.ts';

/**
 * `--device=`: a device's screen, and for --probe=autosim its GPU modelled on the dev GPU (`?autosim=x,noise,pixels`, see
 * src/auto-quality.ts). `amd`, the reference low-end PC (the user's, 2026-11-06): an AMD RDNA 2 iGPU, 1280x585 CSS at DPR 3,
 * display rate unknown. Its production report at tau 8 and 50% resolution, a 3840x1755 output (6.74M pixels): 44.4 ms; TAA or
 * upscaling off -26..28, half the scene's pixels -8.5; the dev GPU there (`amdground`) 1.82 ms. So nearly all of it goes by pixels:
 * 1 x 1.82 + 64 x 0.5^2 + 4 x 6.74 = 44.8. (x 15 of the dev GPU, its fixed floor included, read 40-50 ms after every tier.) The
 * shadow map's 7.6 ms isn't in it: tier 3 saves nothing here, so it's pessimistic past tier 2.
 */
const DEVICES: Record<string, { size: string; dpr: number; autosim: string }> = {
  amd: { size: '1280x585', dpr: 3, autosim: '1,0.3,64,4' },
};

export const HELP = `Nanite Forest harness: headless benchmark, screenshots and probes (results in tools/out/)

  npm run harness                                  the default views, default settings
  npm run harness -- --views=ground,canopy --frames=200 --query="shadows=0&trees=5000"
  npm run harness -- --url=https://victorzakharov.github.io/threejs-nanites/   the deployed site instead

views and settings
  --views=a,b        viewpoints from tools/harness/views.ts (default: ${DEFAULT_VIEWS.join(',')})
  --query=k=v&...    URL parameters of the demo (see README)
  --scene=lucy       the Lucy forest (250k statues of 4M triangles; = --query=scene=lucy) instead of the forest
  --choose=lucy      show the loading screen's scene choice (the harness skips it) and click that button (forest or
                     lucy; wait: let the countdown run out; hover: move over Lucy 7 s, held, then the forest); saves tools/out/choice.png and checks the scene
  --zoom=5           look through the right-mouse zoom (default: the view's own, else 1)
  --dist[=dir]       the production build in dist/ (npx vite build first), served gzipped as GitHub Pages does; another
                     build's folder (a baseline's worktree: --dist=tools/tmp/base/dist)
  --size=1600x900    viewport;  --frames=120 benchmark frames per view;  --no-shots  skip screenshots
  --device=amd       the reference low-end PC: its screen (--size, --dpr), and its GPU's model for --probe=autosim
  --dpr=3            device pixel ratio (a phone's screen: screenshots at size x dpr; the demo upscales to it)

measuring
  --probe=a,b        run tools/probes/<name>.ts after each view and print what it returns (a \`png\` data URL in it
                     is saved as tools/out/<probe>-<view>.png); see tools/probes/README.md
  --ab="q1|q2"       every view under each query (on top of --query): numbers, screenshots <view>@<k>.png and
                     mean colours (all pixels / tree pixels) per variant
  --sweep=lod,shadowlod,shadow,detail   hold the view, move only the LOD reference / shadow-caster LOD reference /
                     shadow-map centre / the ground detail's reference (--steps=30 --step=3 m); counts brightness jumps, heatmap sweep-<what>-<view>.png
  --dolly            move the camera in small steps (--steps=40 --step=0.5 m); counts tiles that flicker,
                     heatmap dolly-<view>.png
  --turn=DEG         --dolly: also turn the camera this many degrees (yaw) per step (mouse look; --step=0 to only turn)
  --rise=M           --dolly: also climb this many metres per step (negative: descend)
  --rect=x,y,w,h     --dolly: count only the tiles inside this screen rectangle (e.g. the distant treeline)
  --play             flies a route with real input (a click captures the mouse, held keys, mouse moves) in the page's
                     loop, then prints the panel's report (--query=perf=1; --playwait=15 s to settle first; harness/play.ts)
  --copykey          a real press of C while zoomed (--query=perf=1): what reaches the clipboard
  --zoomtime         the real loop with auto quality: 5 s unzoomed, then the 5x zoom; screenshots over the 6 s after
                     (zoomtime-<view>-<ms>.png), tau / resolution / shadow map / GPU ms by 250 ms, pixels changed between shots
  --flytime=ShiftLeft,KeyW   the same, but holding these keys for 6 s from the view (flying; Shift: fast) instead of the
                     zoom: screenshots every 500 ms (flytime-<view>-<ms>.png), and the shadow map's extent steps
  --lodcheck[=2,4.73,8]   each tau's cut vs the model actually drawn at high detail (5x the zoom, no impostors) and
                     shrunk: coverage lost / added and brightness by height on screen, lodcheck-<view>-z<zoom>-t<tau>.png
                     (harness/lodcheck.ts);  --lodtype=lucy  which type (a regular expression on its name);
                     --lodk=5  the reference's extra zoom (higher if its line says CAP)
  --timeout=N        give up after N seconds, naming the step it was in. Default: what the run should take
                     (30 s + 8 s per view and variant + 1 s per sweep/dolly step), so a stuck run fails fast
  --typematch        per tree type: coverage and colour of the real trees vs the impostors, and the colour gain
                     that would match them (see harness/typematch.ts)
  --typematch=calibrate   adjust the impostor gains in the page until they match (views looking down steeply
                     calibrate the top-down gains, others the side gains), print values for src/trees.ts
  --typematch=cover  the same for each type's impostor coverage scale (impCov: pixels covered), before the gains
  --flicker          a still camera must render identical frames (use --query=wind=0)
  --eval="expr"      evaluate an expression in the page once after loading;  --eval-file=path  the same from a file

loading
  --load=N           N cold boots (a fresh browser each) instead of the views: the loading log's timeline (median)
                     and the downloads (gzipped sizes);  --cpu=N  slow the page's CPU N x;  --profile  the main
                     thread's CPU profile of the first boot (top functions; tools/out/load.cpuprofile)
                     (a phone: --size=384x832 --dpr=3 --query=touch=1 --cpu=4)
  --loading-shots    screenshots of the loading screen;  --resize-during-load=1280x1000  resize while loading
  --verbose          echo the whole page console

the library
  --example[=gltf]   the library's example page (examples/<name>.html) instead of the demo: its stats line after
                     --frames frames and tools/out/example-<name>.png (harness/example.ts)

image tools: node tools/img.ts (colour stats and enlarged crops of screenshots)`;

/** Parses process.argv into the harness's options. */
export function parseOptions(argv: string[]) {
  const args = Object.fromEntries(
    argv.map((a): [string, string | true] => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
  );
  const device = args.device ? DEVICES[String(args.device)] : undefined;
  if (args.device && !device) throw new Error(`unknown device ${String(args.device)} (${Object.keys(DEVICES).join(', ')})`);
  const [width, height] = String(args.size ?? device?.size ?? '1600x900').split('x').map(Number);
  const simQuery = device && String(args.probe ?? '').split(',').includes('autosim') && !String(args.query ?? '').includes('autosim=') ? `autosim=${device.autosim}` : null;
  const views = args.views ? String(args.views).split(',') : DEFAULT_VIEWS;
  const unknown = views.filter((v) => !VIEWS[v]);
  if (unknown.length) throw new Error(`unknown view(s): ${unknown.join(', ')} (see tools/harness/views.ts)`);
  const base = {
    help: Boolean(args.help || args.h),
    width,
    height,
    dpr: Number(args.dpr ?? device?.dpr ?? 1),
    frames: Number(args.frames ?? 120),
    // (--scene and --choose are URL parameters too, see src/scene.ts)
    query: [args.query, simQuery, args.scene && `scene=${args.scene}`, args.choose && 'choose=1'].filter((q) => typeof q === 'string' && q).join('&'),
    choose: args.choose ? String(args.choose) : null,
    views,
    zoom: args.zoom === undefined ? undefined : Number(args.zoom), // (unset: the view's own zoom, else 1)
    url: args.url ? String(args.url) : null,
    dist: args.dist === undefined ? null : args.dist === true ? 'dist' : String(args.dist), // (a folder, from the project root)
    shots: !args['no-shots'],
    probes: args.probe ? String(args.probe).split(',') : [],
    variants: args.ab ? String(args.ab).split('|') : null,
    sweep: args.sweep ? String(args.sweep).split(',') : null,
    dolly: Boolean(args.dolly),
    zoomtime: Boolean(args.zoomtime),
    copykey: Boolean(args.copykey),
    play: Boolean(args.play),
    playwait: Number(args.playwait ?? 15),
    flytime: args.flytime ? String(args.flytime).split(',') : null,
    turn: args.turn ? Number(args.turn) : 0,
    rise: args.rise ? Number(args.rise) : 0,
    rect: args.rect ? String(args.rect).split(',').map(Number) : null,
    typematch: args.typematch ? (args.typematch === 'calibrate' || args.typematch === 'cover' ? args.typematch : 'measure') : null,
    lodcheck: args.lodcheck ? (args.lodcheck === true ? [2, 4.73, 8] : String(args.lodcheck).split(',').map(Number)) : null,
    lodtype: String(args.lodtype ?? 'lucy'),
    lodk: Number(args.lodk ?? 5),
    timeout: args.timeout === undefined ? null : Number(args.timeout), // (null: expectedSeconds, see below)
    steps: args.steps ? Number(args.steps) : null,
    step: args.step !== undefined ? Number(args.step) : null,
    flicker: Boolean(args.flicker),
    eval: args.eval ? String(args.eval) : null,
    evalFile: args['eval-file'] ? String(args['eval-file']) : null,
    loadingShots: Boolean(args['loading-shots']),
    load: args.load === undefined ? 0 : args.load === true ? 1 : Number(args.load),
    cpu: args.cpu ? Number(args.cpu) : 0,
    profile: Boolean(args.profile),
    resizeDuringLoad: args['resize-during-load'] ? String(args['resize-during-load']).split('x').map(Number) : null,
    verbose: Boolean(args.verbose),
    example: args.example === undefined ? null : args.example === true ? 'gltf' : String(args.example),
  };
  return { ...base, timeout: base.timeout ?? expectedSeconds(base) };
}

/** The harness's options (see HELP). */
export type Options = ReturnType<typeof parseOptions>;

/** A generous estimate of a run's wall time (a basic two-view run takes ~20 s), for the watchdog. */
function expectedSeconds(o: { load: number; views: string[]; variants: string[] | null; sweep: string[] | null; dolly: boolean; zoomtime: boolean; flytime: string[] | null; play: boolean; steps: number | null; typematch: string | null; lodcheck: number[] | null }): number {
  const runs = o.views.length * (o.variants?.length ?? 1);
  const steps = ((o.sweep?.length ?? 0) + (o.dolly ? 1 : 0)) * (o.steps ?? 40) + (o.typematch ? 30 : 0) + (o.zoomtime || o.flytime ? 25 : 0) + (o.play ? 60 : 0) + (o.lodcheck ? 40 * (o.lodcheck.length + 1) : 0);
  if (o.load) return 30 + o.load * (o.variants?.length ?? 1) * 120; // (throttled boots can take a minute or two)
  return Math.round(30 + runs * (8 + steps));
}
