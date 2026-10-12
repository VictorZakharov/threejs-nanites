// The GPU profile as a person runs it (src/menu.ts, src/profile-banner.ts): opens the settings, clicks Profile GPU,
// runs the real loop and reads the banner every few seconds until it says done (or failed); leaves it showing for the
// screenshot. Returns each distinct banner text with the seconds since the click, and whether the copy button shows.
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) =>
  demo.withLoop(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    document.querySelector<HTMLElement>('#menu [data-a="profile"]')?.click();
    const banner = document.getElementById('profile-banner');
    if (!banner) return { error: 'no banner' };
    const t0 = performance.now(), seen: string[] = [];
    const text = () => [...banner.querySelectorAll('.pb-title, .pb-step')].map((e) => e.textContent).join(' | ');
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const t = text(), s = `${((performance.now() - t0) / 1000).toFixed(0)} s: ${t}`;
      if (!seen.length || !seen[seen.length - 1].endsWith(t)) seen.push(s);
      if (/done|failed/i.test(t) || performance.now() - t0 > 240000) break;
    }
    const copy = banner.querySelector<HTMLElement>('[data-a="copy"]');
    return { shown: !banner.classList.contains('hidden'), copyButton: Boolean(copy && !copy.classList.contains('hidden')), seen };
  })
