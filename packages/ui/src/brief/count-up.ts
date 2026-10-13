/** `use:countUp={n}`: measured numbers count up once; reduced motion shows the value at once. */
export function countUp(node: HTMLElement, to: number) {
  let raf = 0;
  function run(target: number): void {
    cancelAnimationFrame(raf);
    const still = typeof window === "undefined" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    if (still || typeof requestAnimationFrame === "undefined") {
      node.textContent = String(target);
      return;
    }
    const t0 = performance.now() + 300;
    const step = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - t0) / 1200));
      node.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    node.textContent = "0";
    raf = requestAnimationFrame(step);
  }
  run(to);
  return {
    update: run,
    destroy: () => cancelAnimationFrame(raf),
  };
}
