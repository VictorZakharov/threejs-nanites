// The GPU profile's progress on screen (src/profile.ts runs it from the settings menu): a banner at the top with the
// step, a bar and the time left, then "done" with a copy button. Its only sign used to be the performance panel's
// last line: on a phone a tiny line nobody saw change (the user: "I have no idea if its working").

export interface ProfileBanner {
  progress(label: string, step: number, steps: number, secondsLeft: number | null): void;
  /** Finished: `copy` copies the report (a tap is the gesture the clipboard needs). */
  done(copy: () => Promise<void>): void;
  failed(): void;
}

export function createProfileBanner(): ProfileBanner {
  const el = document.createElement('div');
  el.id = 'profile-banner';
  el.className = 'hidden';
  el.innerHTML = `
    <div class="pb-title"></div>
    <div class="pb-step"></div>
    <div class="pb-bar"><i></i></div>
    <div class="pb-actions"><button type="button" class="menu-btn primary" data-a="copy">Copy report</button><button type="button" class="menu-btn" data-a="close">Close</button></div>`;
  document.body.append(el);
  const $ = (s: string) => el.querySelector<HTMLElement>(s)!;
  const title = $('.pb-title'), step = $('.pb-step'), bar = $('.pb-bar i'), actions = $('.pb-actions');
  let copy: (() => Promise<void>) | null = null;
  el.addEventListener('pointerdown', (e) => e.stopPropagation()); // (not a look drag on the canvas below)
  el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'close') el.classList.add('hidden');
    if (a === 'copy' && copy) {
      await copy();
      step.textContent = 'Copied: paste it wherever you need it.';
    }
  });
  const show = (t: string, s: string, share: number | null): void => {
    el.classList.remove('hidden');
    title.textContent = t;
    step.textContent = s;
    bar.parentElement!.classList.toggle('hidden', share === null);
    if (share !== null) bar.style.width = `${Math.round(share * 100)}%`;
  };
  return {
    progress(label, i, n, left) {
      actions.classList.add('hidden');
      const eta = left === null ? 'estimating the time left' : left < 60 ? `about ${Math.max(1, Math.round(left))} s left` : `about ${Math.round(left / 60)} min left`;
      show("Profiling the GPU: don't move the view", `Step ${i + 1} of ${n}: ${label} · ${eta}`, i / n);
    },
    done(c) {
      copy = c;
      actions.classList.remove('hidden');
      show('GPU profile done', 'It is in the performance report: copy it and send it over.', 1);
    },
    failed() {
      copy = null;
      actions.classList.remove('hidden');
      $('[data-a="copy"]').classList.add('hidden');
      show('GPU profile failed', 'This GPU gave no timings (no timestamp queries?).', null);
    },
  };
}
