<script lang="ts">
  /**
   * The badge card: the collectible version of an earned badge (the approved
   * "Color set" foil card from hq-accomplishment-badges). The full-colour
   * ASCII badge on a #17161A card, a frame in the tier colour, the badge
   * name, what earns it, its tier and when it was earned.
   *
   * With `foil` it draws the holographic foil with WebGPU (foil-gpu.ts). Where
   * WebGPU is missing (the macOS 13 webview) the card stays the static
   * version: the same layout and art without the foil, with a soft light
   * that follows the pointer instead. With `interactive` it tilts toward the
   * pointer; reduced motion keeps it flat.
   *
   * The card is dark in both app themes: no colour here comes from a theme
   * variable, and the badge art always uses the dark palette. Type and
   * spacing scale with the card's width (container units, designed at
   * 280px), so the same card works on the stage and in the binder.
   */
  import BadgeMark from "./BadgeMark.svelte";
  import { BADGE_FONT } from "./badge-mark.js";
  import { drawFullBadge } from "./full-badge.js";
  import type { AsciiArt } from "./full-ascii-data.js";
  import type { ResolvedBadge } from "./badge-catalog.js";
  import { cardAccessibleLabel, cardDate, cardNumber, cardTierLabel, cardTilt, cardTransform, pointerOnCard, prefersReducedMotion } from "./badge-card.js";
  import { createFoil, type Foil } from "./foil-gpu.js";

  interface Props {
    badge: ResolvedBadge;
    /** Try the WebGPU foil. Off for thumbnails. */
    foil?: boolean;
    /** Tilt and light toward the pointer. */
    interactive?: boolean;
    /** Width in px; omit to fill the container. */
    width?: number | null;
    /** Called with "gpu" or "static" once the card knows how it draws. */
    onrender?: (mode: "gpu" | "static") => void;
  }

  let { badge, foil = true, interactive = true, width = null, onrender }: Props = $props();

  const tierKey = $derived(badge.tier === "L" ? "L" : String(badge.tier));
  const label = $derived(cardAccessibleLabel(badge));

  let cardEl = $state<HTMLDivElement | null>(null);
  let tiltEl = $state<HTMLDivElement | null>(null);
  let holoEl = $state<HTMLCanvasElement | null>(null);
  let artEl = $state<HTMLCanvasElement | null>(null);
  let titleEl = $state<HTMLDivElement | null>(null);
  let art = $state<AsciiArt | null | undefined>(undefined);
  let mode = $state<"pending" | "gpu" | "static">("pending");
  let renderer: Foil | null = null;

  // The art: the app's full ASCII Color export, always the dark colours.
  $effect(() => {
    const key = `${badge.def.id}:${badge.tier}`;
    const fallback = `${badge.def.id}:${badge.def.tier}`;
    let alive = true;
    import("./full-ascii-data.js").then(
      ({ FULL_ASCII }) => {
        if (alive) art = FULL_ASCII[key] ?? FULL_ASCII[fallback] ?? null;
      },
      () => {
        if (alive) art = null;
      },
    );
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    const cv = artEl;
    const a = art;
    if (!cv || !a) return;
    let alive = true;
    const draw = () => {
      if (!alive) return;
      drawFullBadge(cv, a, { scale: 4, theme: "dark" });
      // The card sizes the art from its own width, not the drawn pixel size.
      cv.style.width = "";
      cv.style.height = "";
      renderer?.updateArt();
      renderer?.measure();
    };
    draw();
    document.fonts?.load(`500 10px ${BADGE_FONT}`).then(draw, () => {});
    return () => {
      alive = false;
    };
  });

  // The foil, while the card is on screen. Static until the GPU says yes.
  $effect(() => {
    const canvas = holoEl;
    const card = cardEl;
    const artCanvas = artEl;
    const title = titleEl;
    const tier = tierKey;
    if (!foil || !canvas || !card || !artCanvas || !title) {
      mode = "static";
      return;
    }
    mode = "pending";
    const r = createFoil({ canvas, card, art: artCanvas, title, tier }, () => {
      mode = "static";
      renderer?.dispose();
      renderer = null;
    });
    renderer = r;
    let ro: ResizeObserver | null = null;
    void r.ready.then((ok) => {
      if (renderer !== r) return;
      mode = ok ? "gpu" : "static";
      if (!ok) return;
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => r.measure());
        ro.observe(card);
      }
      r.updateArt();
      r.measure();
      paint();
    });
    return () => {
      ro?.disconnect();
      r.dispose();
      if (renderer === r) renderer = null;
    };
  });

  $effect(() => {
    if (mode !== "pending") onrender?.(mode);
  });

  // Pointer → light and tilt, eased. The loop runs only while something is
  // still moving, and never while the window is hidden.
  const s = { px: 0, py: 0, target: 0, hover: 0, tx: 0, ty: 0, lx: 0.2, ly: -0.25 };
  let raf = 0;
  let lastAt = 0;
  let still = false;

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
    const d = Math.max(
      Math.abs(want.x - s.tx),
      Math.abs(want.y - s.ty),
      Math.abs(s.target - s.hover),
      s.target ? Math.max(Math.abs(s.px - s.lx), Math.abs(s.py - s.ly)) : 0,
    );
    return d < 1e-3;
  }

  function paint(): void {
    const el = tiltEl;
    if (el) {
      el.style.transform = cardTransform({ x: s.tx, y: s.ty }, el.offsetWidth || 280);
      el.style.setProperty("--light-x", `${((s.lx + 1) * 50).toFixed(1)}%`);
      el.style.setProperty("--light-y", `${((s.ly + 1) * 50).toFixed(1)}%`);
      el.style.setProperty("--light", s.hover.toFixed(3));
    }
    renderer?.draw({ tiltX: s.tx, tiltY: s.ty, lightX: s.lx, lightY: s.ly, hover: s.hover });
  }

  function loop(now: number): void {
    raf = 0;
    const dt = Math.min((now - lastAt) / 1000, 0.1);
    lastAt = now;
    still = step(dt);
    paint();
    if (!still && !document.hidden) raf = requestAnimationFrame(loop);
  }

  function wake(): void {
    if (raf || (typeof document !== "undefined" && document.hidden)) return;
    lastAt = performance.now();
    raf = requestAnimationFrame(loop);
  }

  $effect(() => {
    const el = cardEl;
    if (!interactive || !el) return;
    const move = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      const p = pointerOnCard(el.getBoundingClientRect(), e.clientX, e.clientY);
      s.px = p.x;
      s.py = p.y;
      s.target = p.near;
      wake();
    };
    const leave = () => {
      s.target = 0;
      wake();
    };
    const visibility = () => {
      if (document.hidden && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!document.hidden && !still) wake();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", visibility);
      // Settle flat when the card stops listening.
      s.target = 0;
      s.tx = s.ty = s.hover = 0;
      paint();
    };
  });

  $effect(() => () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });
</script>

<div class="badge-card" style:width={width ? `${width}px` : null} data-testid="badge-card" data-badge-id={badge.def.id} data-render={mode}>
  <div class="tilt" bind:this={tiltEl}>
    <div
      bind:this={cardEl}
      class="card t{tierKey}"
      class:gpu={mode === "gpu"}
      class:interactive
      role="img"
      aria-label={label}
    >
      <canvas class="holo" bind:this={holoEl} aria-hidden="true"></canvas>
      <div class="face" aria-hidden="true">
        <div class="top">
          <svg class="logo" viewBox="0 0 577 330" aria-hidden="true"><path d="M176.594 7.54293H243.149V318.135H176.594V185.024H66.5555V318.135H0V7.54293H66.5555V118.469H176.594V7.54293Z"/><path d="M529.768 329.671L496.49 296.837C484.806 304.824 471.938 311.036 457.888 315.473C443.985 319.91 429.343 322.128 413.961 322.128C392.959 322.128 373.214 317.987 354.727 309.705C336.239 301.274 319.97 289.738 305.919 275.096C291.869 260.306 280.85 243.223 272.863 223.848C264.877 204.325 260.883 183.397 260.883 161.064C260.883 138.879 264.877 118.099 272.863 98.7239C280.85 79.201 291.869 62.0445 305.919 47.2544C319.97 32.4642 336.239 20.928 354.727 12.6455C373.214 4.21517 392.959 0 413.961 0C435.111 0 454.93 4.21517 473.417 12.6455C491.905 20.928 508.174 32.4642 522.225 47.2544C536.275 62.0445 547.22 79.201 555.059 98.7239C563.045 118.099 567.039 138.879 567.039 161.064C567.039 177.185 564.82 192.641 560.383 207.431C556.094 222.073 550.178 235.754 542.635 248.474L576.8 282.639L529.768 329.671ZM413.961 255.573C420.025 255.573 425.867 254.907 431.487 253.576C437.255 252.245 442.802 250.396 448.126 248.03L429.491 229.394L476.523 182.362L492.94 198.779C495.454 193.011 497.303 186.947 498.486 180.587C499.818 174.227 500.483 167.72 500.483 161.064C500.483 148.049 498.191 135.847 493.606 124.459C489.169 113.07 482.957 103.087 474.97 94.5087C466.984 85.7826 457.74 78.9791 447.239 74.0984C436.886 69.0698 425.793 66.5554 413.961 66.5554C402.129 66.5554 390.962 69.0698 380.461 74.0984C370.108 78.9791 360.939 85.7826 352.952 94.5087C344.965 103.087 338.679 113.07 334.094 124.459C329.657 135.847 327.439 148.049 327.439 161.064C327.439 174.079 329.657 186.355 334.094 197.892C338.679 209.28 344.965 219.337 352.952 228.063C360.939 236.642 370.108 243.371 380.461 248.252C390.962 253.133 402.129 255.573 413.961 255.573Z"/></svg>
          <span>{cardNumber(badge.def.id)}</span>
        </div>
        <div class="art">
          {#if art === null}
            <BadgeMark badge={badge.def} tier={badge.tier} size="small" label="" />
          {:else}
            <canvas bind:this={artEl} width="216" height="216" data-card-art={badge.def.id}></canvas>
          {/if}
        </div>
        <div class="nm" bind:this={titleEl}>{badge.def.name}</div>
        <div class="cr">{badge.def.crit}.</div>
        <div class="bot"><b>{cardTierLabel(badge.tier)}</b><span>{cardDate(badge.earnedAt)}</span></div>
      </div>
      <span class="frame" aria-hidden="true"></span>
      <span class="glare" aria-hidden="true"></span>
      <span class="rim" aria-hidden="true"></span>
    </div>
  </div>
</div>

<style>
  /* Approved carve-out: the card keeps its own dark palette in both themes. */
  .badge-card { position: relative; flex: none; width: 100%; }
  .tilt { position: relative; will-change: transform; }
  .card {
    /* Everything scales from a 280px card. */
    --u: calc(100cqw / 280);
    --title: #f4efe8;
    --sub: rgba(244, 239, 232, 0.55);
    --edge: rgba(255, 255, 255, 0.12);
    position: relative; container-type: inline-size;
    aspect-ratio: 5 / 7; border-radius: 4.3% / 3.07%; overflow: hidden;
    background: #17161A; color: var(--title);
    backface-visibility: hidden; -webkit-backface-visibility: hidden;
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card.t1 { --edge: #785037; }
  .card.t2 { --edge: #686b79; }
  .card.t3 { --edge: #917125; }
  .card.tL { --edge: transparent; }
  .holo { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .face { position: absolute; inset: 0; display: flex; flex-direction: column; padding: calc(var(--u) * 22) calc(var(--u) * 24) calc(var(--u) * 21); }
  .top {
    display: flex; justify-content: space-between; align-items: center;
    padding: calc(var(--u) * 2) calc(var(--u) * 4) 0;
    font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: calc(var(--u) * 9.5); letter-spacing: 0.16em; text-transform: uppercase; color: var(--sub);
  }
  .logo { display: block; width: auto; height: calc(var(--u) * 15); fill: currentColor; }
  .art { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  .art canvas { display: block; width: calc(var(--u) * 216); max-width: 100%; height: auto; }
  .card.gpu .art canvas { opacity: 0; }
  .nm { padding: 0 calc(var(--u) * 4); font-size: calc(var(--u) * 24); font-weight: 500; letter-spacing: -0.04em; line-height: 1.05; color: var(--title); }
  .cr { margin: calc(var(--u) * 5) 0 0; padding: 0 calc(var(--u) * 4); min-height: calc(var(--u) * 31); font-size: calc(var(--u) * 11.5); line-height: 1.35; color: var(--sub); }
  .bot {
    display: flex; justify-content: space-between; align-items: flex-end; gap: calc(var(--u) * 8);
    margin: calc(var(--u) * 10) calc(var(--u) * 4) 0; padding: calc(var(--u) * 8) 0 0;
    border-top: 1px solid var(--edge);
    font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: calc(var(--u) * 8); letter-spacing: 0.14em; text-transform: uppercase; color: var(--sub);
  }
  .bot b { font-weight: 500; color: var(--title); }
  .card.tL .bot { border-image: linear-gradient(90deg, #3b22d0, #9a4ad6, #ec6f86, #fca58a) 1; }
  .frame { position: absolute; inset: calc(var(--u) * 8); border-radius: calc(var(--u) * 9); border: 1px solid var(--edge); pointer-events: none; }
  .card.tL .frame {
    border: 0; padding: 1px;
    background: linear-gradient(135deg, #3b22d0, #9a4ad6, #ec6f86, #fca58a);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
    mask-composite: exclude;
  }
  /* The static card's light: a soft glow under the pointer, no foil. */
  .glare {
    position: absolute; inset: 0; pointer-events: none; opacity: 0;
    background: radial-gradient(circle at var(--light-x, 60%) var(--light-y, 37%), rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 55%);
  }
  .card.interactive:not(.gpu) .glare { opacity: var(--light, 0); }
  .rim { position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07); pointer-events: none; }
  .card.gpu .rim { display: none; }
</style>
