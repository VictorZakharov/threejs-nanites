// Where auto quality settled on the last visit (src/auto-quality.ts keeps it per screen in localStorage), for what's built
// once at load.

/**
 * The low-end tier the last visit on this screen settled at (any scene; 0 when none was kept), for what's built once at load
 * (the grass's density). Not under the harness unless `?autoremember=1`.
 */
export function rememberedTier(params: URLSearchParams, harness: boolean): number {
  if (params.has('remembertier')) return Number(params.get('remembertier')); // (a test: as if the last visit settled there)
  if (params.get('autoremember') === '0' || (harness && params.get('autoremember') !== '1')) return 0;
  const screenKey = ` ${screen.width}x${screen.height}@${devicePixelRatio} `;
  let tier = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('nanite-auto ') && k.includes(screenKey)) tier = Math.max(tier, (JSON.parse(localStorage.getItem(k) ?? '{}') as { tier?: number }).tier ?? 0);
    }
  } catch {
    // (storage blocked: 0)
  }
  return tier;
}

/** A setting to start at: where the last visit settled, or the lite start (`lite`: the last tier, half the resolution). */
export interface StartAt {
  tier: number;
  scale: number;
  tau: number;
  lite: boolean;
}

/**
 * Where auto quality settled, kept per screen (`auto.remember`: the storage key; not under the harness): the next visit starts
 * there, not at full quality (the AMD PC's first 16 s at 15-17 fps). Written once it has held still 8 s; it moves on from
 * there as usual. With nothing kept, `lite()` > 0 starts at that tier and half the resolution (src/auto-quality.ts).
 * Returns the per-frame call.
 */
export function createRemember(
  auto: { on: boolean; remember?: string; maxTau: number },
  tau: { value: number },
  o: { start(to: StartAt): void; current(): { tier: number; scale: number; tau: number }; still(now: number): boolean; lite(): number },
): (now: number) => void {
  let restored = false, lastSave = 0;
  return (now) => {
    const key = auto.remember;
    if (!key && restored) return;
    try {
      if (!restored) {
        restored = true;
        const s = key ? (JSON.parse(localStorage.getItem(key) ?? 'null') as { tier: number; scale: number; tau: number } | null) : null;
        if (!auto.on) return;
        const lite = o.lite();
        // (coarse at once: from tau 1 the lite start's first frames drew 814k triangles at 20-30 fps; src/auto-quality.ts sets it)
        if (!s && lite > 0) o.start({ tier: lite, scale: 0.5, tau: Math.max(tau.value, auto.maxTau), lite: true });
        else if (s) o.start({ ...s, lite: false });
        return;
      }
      if (!key || !auto.on || now - lastSave < 5000 || !o.still(now)) return;
      lastSave = now;
      localStorage.setItem(key, JSON.stringify(o.current()));
    } catch {
      // (storage blocked: it starts at full quality, as before)
    }
  };
}
