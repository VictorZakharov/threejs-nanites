// Settings menu (src/menu.ts): opens it with Esc, flips a few switches by clicking them and reads back that the
// state followed (each checkbox is re-read from the real setting after every click); leaves it open for the
// screenshot. With --query=touch=1 the touch layout (gear button, touch controls list).
import type { Demo } from '../../src/harness-api.ts';

async (demo: Demo) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
  const menu = document.getElementById('menu')!;
  const box = (label: string) => [...menu.querySelectorAll('label.opt')].find((l) => l.textContent?.includes(label))?.querySelector('input');
  const flip = (label: string): string => {
    const b = box(label);
    if (!b) return 'missing';
    const before = b.checked;
    b.click();
    const after = box(label)?.checked;
    b.click();
    return `${before} -> ${after} -> ${box(label)?.checked}`;
  };
  const seg = (name: string, v: string) => {
    menu.querySelector<HTMLElement>(`[data-seg="${name}"] button[data-v="${v}"]`)?.click();
    return menu.querySelector<HTMLElement>(`[data-seg="${name}"] button.active`)?.dataset.v;
  };
  const r: Record<string, unknown> = {
    open: !menu.classList.contains('hidden'),
    shadows: flip('Shadows'), taa: flip('TAA'), rays: flip('God rays'), wind: flip('Wind'), clouds: flip('Clouds'), grass: flip('Grass'), relief: flip('Ground relief'),
    occlusion: flip('Occlusion'), sw: flip('Software'),
    quality: [seg('quality', 'low'), seg('quality', 'auto')].join(' '),
    tau: demo.forest.u.tau.value,
    gear: Boolean(document.querySelector('.touch-menu')),
  };
  // in a short window only the columns scroll: the title and the buttons stay inside the box (the user's screenshot)
  const cols = menu.querySelector('.menu-cols')!, mbox = menu.querySelector('.menu-box')!, mb = mbox.getBoundingClientRect();
  const inBox = (sel: string): boolean => { const b = menu.querySelector(sel)!.getBoundingClientRect(); return b.top >= mb.top && b.bottom <= mb.bottom; };
  cols.scrollTop = 1e6;
  r.scroll = { overflow: cols.scrollHeight > cols.clientHeight, scrolled: cols.scrollTop, boxScrolls: mbox.scrollHeight > mbox.clientHeight + 1, title: inBox('h2'), buttons: inBox('.menu-actions') };
  return r;
}
