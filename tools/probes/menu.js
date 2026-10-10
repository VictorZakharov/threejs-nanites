// Settings menu (src/menu.ts): opens it with Esc, flips a few switches by clicking them and reads back that the
// state followed (each checkbox is re-read from the real setting after every click); leaves it open for the
// screenshot. With --query=touch=1 the touch layout (gear button, touch controls list).
async (demo) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
  const menu = document.getElementById('menu');
  const box = (label) => [...menu.querySelectorAll('label.opt')].find((l) => l.textContent.includes(label))?.querySelector('input');
  const flip = (label) => {
    const b = box(label);
    if (!b) return 'missing';
    const before = b.checked;
    b.click();
    const after = box(label).checked;
    b.click();
    return `${before} -> ${after} -> ${box(label).checked}`;
  };
  const seg = (name, v) => {
    menu.querySelector(`[data-seg="${name}"] button[data-v="${v}"]`).click();
    return menu.querySelector(`[data-seg="${name}"] button.active`)?.dataset.v;
  };
  const r = {
    open: !menu.classList.contains('hidden'),
    shadows: flip('Shadows'), taa: flip('TAA'), rays: flip('God rays'), wind: flip('Wind'), clouds: flip('Clouds'), grass: flip('Grass'), relief: flip('Ground relief'),
    occlusion: flip('Occlusion'), sw: flip('Software'),
    quality: [seg('quality', 'low'), seg('quality', 'auto')].join(' '),
    tau: demo.forest.u.tau.value,
    gear: Boolean(document.querySelector('.touch-menu')),
  };
  return r;
}
