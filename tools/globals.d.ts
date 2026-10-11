// What the page exposes to the harness (page.evaluate callbacks) and its probes: src/harness-api.ts.
import type { Demo } from '../src/harness-api.ts';

declare global {
  interface Window {
    __demo: Demo;
  }
}
