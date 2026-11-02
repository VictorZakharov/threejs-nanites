// For the performance panel's report: what changed in the seconds after the last zoom in (ms since it started). The
// user sees statues change "~1sec after" a zoom that the harness's views don't reproduce, and only a report taken at
// their own spot can say what moved there.
import type { NaniteForest } from './forest/forest.ts';

const WATCH_MS = 4000; // how long after a zoom it logs
const SLOW_MS = 50; // a frame over this is logged
const COUNT_MS = 200; // how often it reads the cluster and impostor counts (a readback)
const MAX_EVENTS = 60;

interface Watched {
  tau: { value: number };
  scale(): number;
  shadow(): { size: number; half: number };
  zoom: { zoom: number; zoomTarget: number };
  forest: Pick<NaniteForest, 'readStats' | 'fills'>;
}

export function createZoomLog(w: Watched) {
  const events: string[] = [];
  let t0 = 0, was = false, settled = false, nextCount = 0, busy = false, last = '';
  const add = (now: number, text: string): void => {
    if (events.length < MAX_EVENTS) events.push(`+${Math.round(now - t0)} ms  ${text}`);
  };
  const state = (): string => {
    const s = w.shadow();
    return `tau ${w.tau.value.toFixed(2)}, scale ${w.scale().toFixed(2)}, shadow map ${s.size} over ${Math.round(s.half)} m, model fills ${w.forest.fills}`;
  };
  return {
    frame(now: number, dt: number): void {
      const zoomed = w.zoom.zoomTarget > 1;
      if (zoomed && !was) {
        t0 = now;
        settled = false;
        nextCount = 0;
        events.length = 0;
        last = state();
        add(now, `zoom in: ${last}`);
      }
      was = zoomed;
      if (!t0 || now - t0 > WATCH_MS) return;
      const s = state();
      if (s !== last) add(now, (last = s));
      if (!settled && w.zoom.zoom === w.zoom.zoomTarget) {
        settled = true;
        add(now, 'the zoom has eased');
      }
      if (dt * 1000 > SLOW_MS) add(now, `slow frame: ${Math.round(dt * 1000)} ms`);
      if (now >= nextCount && !busy) {
        nextCount = now + COUNT_MS;
        busy = true;
        void w.forest.readStats().then((c) => {
          busy = false;
          add(performance.now(), `clusters ${c.barkClusters + c.leafClusters}, impostors ${c.impostors}, occluded ${c.occluded}`);
        }, () => void (busy = false));
      }
    },
    report: (): string => (events.length ? ['after the last zoom', ...events].join('\n') : ''),
  };
}
