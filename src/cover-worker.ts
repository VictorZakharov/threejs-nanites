// The canopy cover map (cover.ts) off the main thread.
import { coverPixels, type CoverJob } from './cover.ts';

self.onmessage = (e: MessageEvent<CoverJob>) => {
  const data = coverPixels(e.data);
  (self as unknown as Worker).postMessage(data, [data.buffer]);
};
