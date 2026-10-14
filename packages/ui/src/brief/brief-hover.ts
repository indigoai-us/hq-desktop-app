/**
 * The brief's hover layer (Sunrise Terminal, phase 2), after the badge card
 * (badges/card-hover.ts): cards stay flat at rest; under the pointer a
 * soft light follows it.
 * Every card also tilts a little toward the
 * pointer, the badge card's camera at a third of its angle. Decision titles
 * decode from ASCII glyphs when you reach for them.
 *
 * The element gets `--light-x`, `--light-y` (percent) and `--light` (0..1);
 * brief.css paints from them. Reduced motion keeps everything flat and still.
 * The loop runs only while something is moving and never while the window is
 * hidden.
 */

/** The glyphs of HQ's text-mode art (hqforwork.com, the welcome skyline). */
export const HQ_GLYPHS = ".,/#HQ*";

export interface HoverOptions {
  /** Tilt toward the pointer: reward cards only. */
  tilt?: boolean;
}

/** Pointer position on the element, -1..1 on each axis from its center. */
export function pointerOn(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
  const w = rect.width / 2 || 1;
  const h = rect.height / 2 || 1;
  const cl = (v: number) => Math.max(-1, Math.min(1, v));
  return { x: cl((clientX - (rect.left + w)) / w), y: cl((clientY - (rect.top + h)) / h) };
}

/** The tilt in radians: a third of the badge card's (0.16 / 0.12), scaled by how present the hover is. */
export function hoverTilt(p: { x: number; y: number }, presence: number): { x: number; y: number } {
  return { x: p.x * 0.055 * presence, y: -p.y * 0.04 * presence };
}

/** The tilt as a CSS transform with the badge card's camera (3.5 widths). */
export function tiltTransform(t: { x: number; y: number }, width: number): string {
  if (!t.x && !t.y) return "";
  const persp = Math.round(Math.max(1, width) * 3.5);
  return `perspective(${persp}px) rotateX(${t.y.toFixed(4)}rad) rotateY(${t.x.toFixed(4)}rad)`;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function briefHover(node: HTMLElement, opts: HoverOptions = {}) {
  let tilt = !!opts.tilt;
  const s = { px: 0, py: 0, target: 0, hover: 0, tx: 0, ty: 0, lx: 0, ly: -0.4 };
  let raf = 0;
  let lastAt = 0;

  function paint(): void {
    node.style.transform = tiltTransform({ x: s.tx, y: s.ty }, node.offsetWidth);
    node.style.setProperty("--light-x", `${((s.lx + 1) * 50).toFixed(1)}%`);
    node.style.setProperty("--light-y", `${((s.ly + 1) * 50).toFixed(1)}%`);
    node.style.setProperty("--light", s.hover.toFixed(3));
  }

  function step(dt: number): boolean {
    const reduce = prefersReducedMotion();
    const want = reduce || !tilt ? { x: 0, y: 0 } : hoverTilt({ x: s.px, y: s.py }, s.target);
    const k = reduce ? 1 : 1 - Math.exp(-10 * dt);
    s.tx += (want.x - s.tx) * k;
    s.ty += (want.y - s.ty) * k;
    s.hover += (s.target - s.hover) * k;
    if (s.target > 0) {
      s.lx += (s.px - s.lx) * k;
      s.ly += (s.py - s.ly) * k;
    }
    const moving = Math.max(
      Math.abs(want.x - s.tx),
      Math.abs(want.y - s.ty),
      Math.abs(s.target - s.hover),
      s.target ? Math.max(Math.abs(s.px - s.lx), Math.abs(s.py - s.ly)) : 0,
    );
    return moving < 1e-3;
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
    const p = pointerOn(node.getBoundingClientRect(), e.clientX, e.clientY);
    s.px = p.x;
    s.py = p.y;
    if (!s.target) {
      // Enter where the pointer is, so the light does not slide in from the last spot.
      s.lx = p.x;
      s.ly = p.y;
    }
    s.target = 1;
    wake();
  };
  const leave = () => {
    s.target = 0;
    wake();
  };

  node.addEventListener("pointermove", move, { passive: true });
  node.addEventListener("pointerleave", leave);
  paint();

  return {
    update(next: HoverOptions = {}) {
      tilt = !!next.tilt;
      wake();
    },
    destroy() {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/**
 * One frame of the ASCII decode: characters left of the resolve front show the
 * real text; the rest show a glyph from HQ's set. Spaces stay spaces, so the
 * shape of the line holds. `t` runs 0..1; `seed` varies the glyphs per frame.
 */
export function decodeFrame(text: string, t: number, seed: number): string {
  const front = Math.floor(Math.max(0, Math.min(1, t)) * (text.length + 1));
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (i < front || ch === " ") out += ch;
    else out += HQ_GLYPHS[(i * 7 + seed * 13) % HQ_GLYPHS.length];
  }
  return out;
}

/** How long a decode takes for a title of this length: 240..520 ms. */
export function decodeMs(length: number): number {
  return Math.round(Math.min(520, 240 + length * 6));
}

/**
 * Decode `node`'s text from glyphs when its host is hovered (the closest
 * `[data-decode-host]`, else the node). The scramble is drawn in an overlay on
 * top of the real text, which stays in the DOM untouched (so the framework's
 * own updates and screen readers keep the real words). Reduced motion: none.
 */
export function asciiDecode(node: HTMLElement) {
  let raf = 0;
  let overlay: HTMLSpanElement | null = null;

  function finish(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    overlay?.remove();
    overlay = null;
    node.classList.remove("decoding");
  }

  const start = () => {
    if (raf || prefersReducedMotion() || document.hidden) return;
    const text = node.textContent ?? "";
    if (!text.trim()) return;
    overlay = document.createElement("span");
    overlay.className = "decode-overlay";
    overlay.setAttribute("aria-hidden", "true");
    const style = getComputedStyle(node);
    overlay.style.color = style.color;
    // The overlay carries the title's shadow; the hidden title underneath drops its own (see .decoding),
    // so the shadow is drawn once rather than twice.
    overlay.style.textShadow = style.textShadow;
    // Resolved letters in the title's own face, so the line does not jump when the decode ends;
    // the scrambling tail in mono, a little dimmer.
    const done = document.createElement("span");
    const rest = document.createElement("span");
    rest.className = "decode-rest";
    overlay.append(done, rest);
    node.classList.add("decoding");
    node.append(overlay);
    const began = performance.now();
    const dur = decodeMs(text.length);
    let frame = 0;
    const tick = (now: number) => {
      const t = (now - began) / dur;
      if (t >= 1 || !overlay) {
        finish();
        return;
      }
      frame += 1;
      // Ease out: the front moves quickly, then settles on the last letters.
      const eased = 1 - Math.pow(1 - t, 3);
      const out = decodeFrame(text, eased, frame >> 1);
      const front = Math.min(text.length, Math.floor(eased * (text.length + 1)));
      overlay.firstChild!.textContent = out.slice(0, front);
      overlay.lastChild!.textContent = out.slice(front);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const host = node.closest<HTMLElement>("[data-decode-host]") ?? node;
  host.addEventListener("pointerenter", start);
  return {
    destroy() {
      host.removeEventListener("pointerenter", start);
      finish();
    },
  };
}
