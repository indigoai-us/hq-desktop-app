/**
 * The card's hover, as a Svelte action for surfaces that are not BadgeCard
 * itself (the story on the card's back): the card tilts toward the pointer
 * and a light follows it, eased the same way as BadgeCard.svelte, with the
 * same tilt and camera (badge-card.ts). The element gets the transform and
 * the `--light-x`, `--light-y` and `--light` custom properties its own CSS
 * paints from. Reduced motion keeps it flat. The loop runs only while
 * something is still moving, and never while the window is hidden.
 */

import { cardTilt, cardTransform, pointerOnCard, prefersReducedMotion } from "./badge-card.js";

export function cardHover(node: HTMLElement, enabled: boolean) {
  const s = { px: 0, py: 0, target: 0, hover: 0, tx: 0, ty: 0, lx: 0.2, ly: -0.25 };
  let raf = 0;
  let lastAt = 0;
  let on = false;

  function paint(): void {
    node.style.transform = s.tx || s.ty ? cardTransform({ x: s.tx, y: s.ty }, node.offsetWidth || 280) : "";
    node.style.setProperty("--light-x", `${((s.lx + 1) * 50).toFixed(1)}%`);
    node.style.setProperty("--light-y", `${((s.ly + 1) * 50).toFixed(1)}%`);
    node.style.setProperty("--light", s.hover.toFixed(3));
  }

  function step(dt: number): boolean {
    const reduce = prefersReducedMotion();
    const want = reduce ? { x: 0, y: 0 } : cardTilt({ x: s.px, y: s.py, near: s.target });
    const k = reduce ? 1 : 1 - Math.exp(-10 * dt);
    s.tx += (want.x - s.tx) * k;
    s.ty += (want.y - s.ty) * k;
    s.hover += (s.target - s.hover) * k;
    if (s.target > 0) {
      s.lx += (s.px - s.lx) * k;
      s.ly += (s.py - s.ly) * k;
    }
    return Math.max(Math.abs(want.x - s.tx), Math.abs(want.y - s.ty), Math.abs(s.target - s.hover), s.target ? Math.max(Math.abs(s.px - s.lx), Math.abs(s.py - s.ly)) : 0) < 1e-3;
  }

  function loop(now: number): void {
    raf = 0;
    const dt = Math.min((now - lastAt) / 1000, 0.1);
    lastAt = now;
    const still = step(dt);
    paint();
    if (!still && !document.hidden) raf = requestAnimationFrame(loop);
  }

  function wake(): void {
    if (raf || document.hidden) return;
    lastAt = performance.now();
    raf = requestAnimationFrame(loop);
  }

  const move = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    const p = pointerOnCard(node.getBoundingClientRect(), e.clientX, e.clientY);
    s.px = p.x;
    s.py = p.y;
    s.target = p.near;
    wake();
  };
  const leave = () => {
    s.target = 0;
    wake();
  };

  function start(): void {
    if (on) return;
    on = true;
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
  }

  function stop(): void {
    if (!on) return;
    on = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerdown", move);
    document.documentElement.removeEventListener("pointerleave", leave);
    window.removeEventListener("blur", leave);
    // Settle flat when it stops listening.
    s.target = 0;
    s.tx = s.ty = s.hover = 0;
    paint();
  }

  if (enabled) start();
  paint();
  return {
    update(next: boolean) {
      if (next) start();
      else stop();
    },
    destroy() {
      stop();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
