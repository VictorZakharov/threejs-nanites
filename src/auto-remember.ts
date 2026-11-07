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
