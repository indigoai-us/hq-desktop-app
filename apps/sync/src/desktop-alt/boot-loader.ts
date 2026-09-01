/** Fade-out duration for `#hq-boot`. Keep in sync with desktop-alt.html. */
export const BOOT_LOADER_FADE_MS = 200;

/** Fallback remove delay if `transitionend` never fires (jsdom / reduced motion). */
const BOOT_LOADER_REMOVE_FALLBACK_MS = 400;

const BOOT_LOADER_ID = 'hq-boot';
const BOOT_LOADER_DONE_CLASS = 'hq-boot-done';

function lockCurrentOpacity(el: HTMLElement, doc: Document): void {
  const view = doc.defaultView;
  if (!view) {
    el.style.opacity = '0';
    return;
  }
  const current = view.getComputedStyle(el).opacity;
  el.style.animation = 'none';
  el.style.opacity = current;
  void el.offsetWidth;
  el.style.transition = `opacity ${BOOT_LOADER_FADE_MS}ms ease-out`;
  el.style.opacity = '0';
}

/**
 * Dismiss the inline `#hq-boot` overlay. Idempotent: missing or already
 * dismissing elements are a no-op. Adds `hq-boot-done` (200ms opacity fade)
 * then removes the node on `transitionend`, with a 400ms timeout fallback.
 */
export function dismissBootLoader(doc: Document = document): void {
  const el = doc.getElementById(BOOT_LOADER_ID);
  if (!el || el.classList.contains(BOOT_LOADER_DONE_CLASS)) return;

  lockCurrentOpacity(el, doc);
  el.classList.add(BOOT_LOADER_DONE_CLASS);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.removeEventListener('transitionend', onEnd);
    el.remove();
  };
  const onEnd = (event: Event) => {
    if (event.target !== el) return;
    const propertyName = (event as TransitionEvent).propertyName;
    if (propertyName && propertyName !== 'opacity') return;
    remove();
  };
  el.addEventListener('transitionend', onEnd);
  setTimeout(remove, BOOT_LOADER_REMOVE_FALLBACK_MS);
}
