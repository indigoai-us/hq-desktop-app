<script lang="ts">
  /**
   * The Create brief scene, in the brief's gradient bento: the brief
   * assembling itself. A dusk colour field holds a white pixel sunrise (8 px
   * pitch, after NewBotDawn and the page's own Sunrise card) whose elevation
   * IS the run's progress, with a 24-cell progress strip under it that lights
   * up as the run reports progress. Beside it (`children`) the counter tiles
   * fill in as findings land; the run's status rows (`status`) sit on the
   * field above the strip; buttons (`actions`) sit under the step line.
   *
   * Ready plays one ripple of light out from the sun (the "ready" feedback)
   * and then calls `onbloomdone`. Failed holds the sun where the run stopped,
   * drains the field to grey and marks the stopped cell in the page's one
   * accent. Canvas only, no backdrop-filter, no glow. Reduced motion draws one
   * static frame per change and crossfades it.
   */
  import { onDestroy, onMount, type Snippet } from "svelte";
  import { bloomAt, stripCells, clamp01, dawnDisplay, dawnLook, dawnReadout, easeDawn, litCells, type DawnPhase } from "./brief-dawn.js";

  interface Props {
    progress: number;
    phase: DawnPhase;
    headline?: string;
    step?: string;
    /** Full page (empty state) or a shorter band over the brief. */
    size?: "page" | "masthead";
    onbloomdone?: () => void;
    /** Called once on mount when the scene can draw (so its ready ripple will play and end). */
    onlive?: () => void;
    /** Buttons under the step line (create, retry, wait). */
    actions?: Snippet;
    /** The run's status rows, on the sun field above the strip. */
    status?: Snippet;
    /** What the run has found so far, beside the sun field. */
    children?: Snippet;
  }
  let { progress, phase, headline = "", step = "", size = "page", onbloomdone, onlive, actions, status, children }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let fade = $state(false);
  let raf = 0;
  let shown = 0;
  let failedFade = 0;
  let time = 0;
  let last = 0;
  let bloomStart: number | null = null;
  let bloomFired = false;
  let reduced = false;
  /** The canvas horizon, as a fraction of the field's height; eased when the scene changes shape. */
  let hzNow: number | null = null;
  /** Waiting: the full-bleed card with its copy centred in the sky. */
  const idle = $derived(phase === "idle");
  /** The scene began as the waiting card: on Create, the header opens above it instead of appearing. */
  let fromIdle = $state(false);
  $effect.pre(() => {
    if (phase === "idle") fromIdle = true;
  });

  // The strip: lit cells follow the run; cells lit by one report light in turn.
  /** The strip's measured width: it fills the row, as many cells as fit. */
  let stripW = $state(0);
  const cellCount = $derived(stripCells(stripW));
  const lit = $derived(litCells(progress, phase, cellCount));
  let seenLit = 0;
  let litFrom = 0;
  const stagger = $derived.by(() => {
    if (lit !== seenLit) {
      litFrom = lit > seenLit ? seenLit : lit;
      seenLit = lit;
    }
    return litFrom;
  });
  const readout = $derived(dawnReadout(progress, phase));
  const kicker = $derived(
    phase === "failed" ? "Stopped" : phase === "ready" ? "Ready" : phase === "idle" ? "Daily brief" : size === "page" ? "Creating" : "Creating a new brief",
  );

  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  // Drawn in light over the dusk field, as the page's Sunrise card: a cream sun, white horizon.
  const SUN_A = hex("#fffbf2");
  const SUN_B = hex("#ffd6c2");
  const WHITE = [255, 255, 255];
  const WATER = hex("#ffe9de");
  const noise = (x: number, y: number) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  const grey = (c: number[], d: number) => {
    const l = 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
    return c.map((v) => Math.round(v + (l - v) * d));
  };

  let dtNow = 0;
  function draw(ctx: CanvasRenderingContext2D, W: number, H: number, ripple: number | null, drawn: number): void {
    const look = dawnLook(drawn, failedFade);
    const e = look.elevation;
    const cols = Math.floor(W / 8);
    const rows = Math.floor(H / 8);
    // Waiting, the horizon sits low under the centred copy; the band's step sits in the sky
    // above it and its status on the water below. Eased, so Create brief reshapes the scene calmly.
    const hzWant = phase === "idle" ? 0.68 : size === "page" ? 0.56 : 0.54;
    hzNow = hzNow == null || reduced ? hzWant : hzNow + (hzWant - hzNow) * (1 - Math.exp(-dtNow * 3));
    const hz = Math.floor(rows * hzNow);
    const R = Math.max(3, Math.min((hz - 2) / 2.5, cols * 0.15));
    const cx = cols * (size === "page" ? 0.5 : 0.7);
    // Below the horizon at 0, its top cresting near 0.25, fully up at 1.
    const sy = hz + R * 1.15 - e * (hz * 0.6 + R);
    const d = look.desaturate;
    const tint = (c: number[]) => (d > 0 ? grey(c, d) : c);
    ctx.clearRect(0, 0, W, H);
    // Under the horizon the field sits a step deeper, as on the Sunrise card.
    ctx.fillStyle = "rgba(40,14,60,0.2)";
    ctx.fillRect(0, hz * 8, W, H - hz * 8);
    // Ready: one ring of light runs out from the sun.
    const ring = ripple == null ? null : { r: (ripple / 900) * Math.max(cols, rows) * 0.9, a: bloomAt(ripple) };
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let col = WHITE;
        let a = 0;
        const dist = Math.hypot(x - cx, (y - sy) * 1.05);
        if (y < hz) {
          if (dist < R) {
            col = mix(SUN_A, SUN_B, clamp01((y - (sy - R)) / (2 * R)));
            a = 0.92;
          } else if (dist < R + 2) {
            // A ring of faint cells round the sun: the halo, drawn in cells, never blurred.
            a = (0.16 + 0.06 * Math.sin(time * 1.2)) * (1 - (dist - R) / 2) * (0.4 + 0.6 * e);
          } else {
            const n = noise(x, y);
            a = n < 0.03 && y < hz * 0.75 ? look.stars * (0.06 + 0.1 * Math.sin(time * 1.1 + n * 90) ** 2) + 0.03 : 0.03;
          }
          // Before the sun shows: a faint pixel glow on the horizon where it will rise.
          if (y >= hz - 6 && Math.abs(x - cx) < R * 1.8) {
            const g = (1 - Math.abs(x - cx) / (R * 1.8)) * ((y - (hz - 7)) / 6) * 0.2 * (1 - e) * (0.85 + 0.15 * Math.sin(time * 0.8));
            if (dist >= R) a = Math.max(a, g);
          }
          if (y === hz - 1) a = Math.max(a, 0.28 + 0.5 * e);
        } else {
          const depth = y - hz;
          const my = 2 * hz - y - 1;
          const sway = reduced ? 0 : Math.sin(time * 1.6 + y * 0.7) * (1 + depth * 0.08);
          const wd = Math.hypot(x + sway - cx, (my - sy) * 1.05);
          if (depth < 9 && wd < R && (y % 2 === 0 || depth < 3)) {
            col = WATER;
            a = Math.max(0.06, 0.6 - depth * 0.07) * (0.3 + 0.7 * e);
          } else a = 0.018;
        }
        // Light spreads out from the sun: a soft lit disc with a brighter leading edge.
        if (ring && ring.a > 0) {
          if (Math.abs(dist - ring.r) < 1.3) a = Math.max(a, 0.5 * ring.a);
          else if (dist < ring.r) a = Math.max(a, 0.14 * ring.a);
        }
        if (a > 0.004) {
          const c = tint(col);
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
          ctx.fillRect(x * 8 + 1, y * 8 + 1, 6, 6);
        }
      }
    }
  }

  function frame(now: number): void {
    const el = canvas;
    const box = host;
    if (!el || !box) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
      el.width = Math.round(W * dpr);
      el.height = Math.round(H * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    time += dt;
    dtNow = dt;
    // Read the props once: the bloom-done callback below can end the scene mid-frame.
    const ph = phase;
    const pr = progress;
    const target = ph === "ready" ? 1 : ph === "idle" ? 0 : pr;
    // Failed: the sun holds where the run stopped.
    if (ph !== "failed") shown = easeDawn(shown, target, dt, time, reduced);
    else if (reduced) shown = clamp01(pr);
    failedFade = ph === "failed" ? (reduced ? 1 : Math.min(1, failedFade + dt * 1.2)) : 0;
    let ripple: number | null = null;
    let done = false;
    if (ph === "ready" && (reduced || shown > 0.97)) {
      bloomStart ??= now;
      ripple = reduced ? null : now - bloomStart;
      if (!bloomFired && (reduced || now - bloomStart >= 900)) done = bloomFired = true;
    }
    draw(ctx, W, H, ripple, ph === "failed" ? shown : dawnDisplay(shown, target, time, reduced));
    if (!reduced) raf = requestAnimationFrame(frame);
    if (done) onbloomdone?.();
  }

  onMount(() => {
    reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof requestAnimationFrame !== "function") return;
    if (canvas?.getContext("2d")) onlive?.();
    if (reduced) frame(performance.now());
    else raf = requestAnimationFrame(frame);
  });

  // Reduced motion: one static frame per step, crossfaded.
  $effect(() => {
    void progress;
    void phase;
    if (!reduced || !canvas) return;
    fade = true;
    const t = setTimeout(() => {
      frame(performance.now());
      fade = false;
    }, 120);
    return () => clearTimeout(t);
  });

  onDestroy(() => cancelAnimationFrame(raf));
</script>

{#snippet stepLine()}
  {#if step}
    <p class="step" aria-live="polite" data-testid="brief-dawn-step">
      {#if phase === "running"}<span class="beat" aria-hidden="true"></span>{/if}<span class="step-text">{step}</span>
    </p>
  {/if}
{/snippet}

<div
  class="making s-{size}"
  class:failed={phase === "failed"}
  class:solo={!children}
  class:idle
  data-testid="brief-dawn"
  data-phase={phase}
  data-progress={progress.toFixed(2)}
>
  {#if size === "page" && !idle}
    <div class="head-wrap" class:opening={fromIdle}>
    <header class="head">
      <span class="kicker" data-testid="brief-dawn-kicker">{kicker}</span>
      {#if headline}<h2>{headline}</h2>{/if}
      {@render stepLine()}
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
    </div>
  {/if}
  <div class="bento">
    <!-- The sun field: the page's dusk colour field (brief.css .slot[data-field]). -->
    <div class="slot sun" data-field="dusk">
      <div class="w">
        <div class="sky" bind:this={host}><canvas bind:this={canvas} class:fade aria-hidden="true"></canvas></div>
        {#if idle}
          <!-- Waiting: the copy and the one action, centred in the sky above the hidden sun. -->
          <div class="idle-copy">
            <span class="kicker" data-testid="brief-dawn-kicker">{kicker}</span>
            {#if headline}<h2>{headline}</h2>{/if}
            <p class="caption">Your bot reads your day and lays it out here, in about ten minutes.</p>
            {#if actions}<div class="actions">{@render actions()}</div>{/if}
          </div>
        {/if}
        <div class="over" class:hidden={idle}>
          {#if !idle}
          <span class="lbl">
            <svg viewBox="0 0 256 256" aria-hidden="true"><path d="M240,152H199.55a73.54,73.54,0,0,0,.45-8,72,72,0,0,0-144,0,73.54,73.54,0,0,0,.45,8H16a8,8,0,0,0,0,16H240a8,8,0,0,0,0-16Zm-168-8a56,56,0,1,1,111.41,8H72.59A56.13,56.13,0,0,1,72,144Zm144,56a8,8,0,0,1-8,8H48a8,8,0,0,1,0-16H208A8,8,0,0,1,216,200ZM72.84,43.58a8,8,0,0,1,14.32-7.16l8,16a8,8,0,0,1-14.32,7.16Zm-56,48.84a8,8,0,0,1,10.74-3.58l16,8a8,8,0,0,1-7.16,14.32l-16-8A8,8,0,0,1,16.84,92.42Zm192,15.16a8,8,0,0,1,3.58-10.74l16-8a8,8,0,1,1,7.16,14.32l-16,8a8,8,0,0,1-10.74-3.58Zm-48-55.16,8-16a8,8,0,0,1,14.32,7.16l-8,16a8,8,0,1,1-14.32-7.16Z" /></svg>
            {size === "page" ? "Sunrise" : kicker}
          </span>
          {#if size === "masthead"}
            <div class="mast-copy">
              {@render stepLine()}
              {#if actions}<div class="actions">{@render actions()}</div>{/if}
            </div>
          {/if}
          {#if status}<div class="status">{@render status()}</div>{/if}
          <div class="strip">
            <div class="strip-head">
              <span>Progress</span>
              <span data-testid="brief-dawn-readout">{readout}</span>
            </div>
            <div
              class="cells"
              role="progressbar"
              aria-label="Brief progress"
              aria-valuemin="0"
              aria-valuemax={cellCount}
              aria-valuenow={lit}
              data-testid="brief-dawn-cells"
              data-count={cellCount}
              bind:clientWidth={stripW}
            >
              {#each { length: cellCount } as _, i (i)}
                <span
                  class="cell"
                  class:lit={i < lit}
                  class:next={phase === "running" && i === lit}
                  class:stop={phase === "failed" && i === lit}
                  style:transition-delay={i >= stagger && i < lit ? `${(i - stagger) * 45}ms` : "0ms"}
                ></span>
              {/each}
            </div>
          </div>
          {/if}
        </div>
      </div>
    </div>
    <!-- Always present, so the columns can ease open when the counters arrive. -->
    <div class="side">{#if children}{@render children()}{/if}</div>
  </div>
</div>

<style>
  .making {
    --mono: var(--b-code, "Geist Mono", ui-monospace, monospace);
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
  }
  /* Opening from the waiting card: the header's row grows from nothing, so the card below
     eases down instead of jumping. */
  .head-wrap {
    display: grid;
    grid-template-rows: 1fr;
  }
  .head-wrap.opening {
    animation: open-head 0.9s cubic-bezier(0.65, 0, 0.35, 1) both;
  }
  .head-wrap > .head {
    min-height: 0;
    overflow: hidden;
  }
  @keyframes open-head {
    from {
      grid-template-rows: 0fr;
    }
  }
  .making.s-masthead {
    margin-bottom: var(--b-gap, 8px);
  }
  /* The page scene fills the brief view: waiting, the card takes all of it. */
  .making.s-page {
    flex: 1 1 auto;
    min-height: 0;
  }
  /* The greeting zone: a mono caps kicker, the headline large and light, the step under it. */
  .head {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 0 22px;
    animation: rise 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .kicker,
  .lbl,
  .strip-head {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    line-height: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .kicker {
    color: rgb(var(--b-ink) / 0.5);
  }
  h2 {
    margin: 2px 0 0;
    font-size: 40px;
    font-weight: 400;
    line-height: 1.08;
    letter-spacing: -0.04em;
    color: rgb(var(--b-ink) / 0.92);
  }
  .step {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    font-size: 15px;
    line-height: 1.4;
    color: rgb(var(--b-ink) / 0.66);
  }
  /* One pixel cell beating beside the live step: the bot is working. */
  .beat {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 1.5px;
    background: rgb(var(--b-ink) / 0.92);
    animation: beat 1.6s ease-in-out infinite;
  }
  .failed .step {
    color: rgb(var(--b-ink) / 0.72);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  /* The bento: the sun field on the left, the counters beside it; alone, it takes the row. */
  .bento {
    display: grid;
    grid-template-columns: 2fr 4fr;
    column-gap: var(--b-gap, 8px);
    align-items: stretch;
    /* Create brief: the card eases from the full view into its place in the bento. */
    --reshape: 0.9s cubic-bezier(0.65, 0, 0.35, 1);
    transition:
      grid-template-columns var(--reshape),
      column-gap var(--reshape),
      flex-grow var(--reshape),
      flex-basis var(--reshape);
  }
  /* Alone (waiting, stopped) the sun field takes the row; the counters' column eases open on Create. */
  .solo .bento {
    grid-template-columns: 1fr 0fr;
    column-gap: 0;
  }
  /* The page: waiting, the card fills the view; creating, the bento has its own height. */
  .s-page .bento {
    flex: 0 0 510px;
  }
  .s-page.idle .bento,
  .s-page.failed .bento {
    flex: 1 1 0%;
    min-height: 420px;
  }
  .side {
    min-width: 0;
    display: flex;
    overflow: hidden;
  }
  .making .sun {
    min-width: 0;
    animation-delay: 70ms;
  }
  .making .sun > :global(.w) {
    height: 100%;
    padding: 0;
    min-height: 0;
  }
  /* Failed: a grey layer in saturation blend drains the field's colour where the run
     stopped; the canvas greys itself, and the strip and text above stay as they are. */
  .making .sun > :global(.w)::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background: #8a8a92;
    mix-blend-mode: saturation;
    opacity: 0;
    transition: opacity 0.8s ease;
  }
  .making.s-masthead .sun > :global(.w) {
    min-height: 248px;
  }
  /* Waiting: the copy centred in the card, white on the dusk sky. */
  .idle-copy {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 32px;
    /* Sit a little above centre, over the sky rather than the horizon. */
    padding-bottom: 12%;
    text-align: center;
    animation: rise 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) 0.15s both;
  }
  .idle-copy .kicker {
    color: rgba(255, 255, 255, 0.8);
  }
  .idle-copy h2 {
    margin: 4px 0 0;
    font-size: 48px;
    color: #fff;
    text-shadow: 0 1px 2px rgba(60, 10, 70, 0.22);
  }
  .caption {
    margin: 0;
    max-width: 560px;
    font-size: 15px;
    line-height: 1.45;
    color: rgba(255, 255, 255, 0.86);
    text-shadow: 0 1px 2px rgba(60, 10, 70, 0.22);
  }
  .idle-copy .actions {
    justify-content: center;
    margin-top: 18px;
  }
  .over.hidden {
    visibility: hidden;
  }
  .making.failed .sun > :global(.w)::before {
    opacity: 0.85;
  }
  .sky {
    position: absolute;
    inset: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transition: opacity 0.3s ease;
  }
  canvas.fade {
    opacity: 0.55;
  }
  .over {
    position: relative;
    z-index: 1;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 20px;
  }
  .lbl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    color: rgba(255, 255, 255, 0.86);
  }
  .lbl svg {
    height: 12px;
    flex: none;
    fill: currentColor;
  }
  /* The band over the brief: the step in white on the field, left of the sun. */
  .mast-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 58%;
  }
  .mast-copy .step {
    font-size: 14px;
    color: #fff;
  }
  .mast-copy .beat {
    background: rgba(255, 255, 255, 0.92);
  }
  .status {
    margin-top: auto;
    min-width: 0;
  }
  .strip {
    margin-top: auto;
  }
  .status + .strip {
    margin-top: 0;
  }
  .strip-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: rgba(255, 255, 255, 0.7);
  }
  .strip-head span:last-child {
    color: rgba(255, 255, 255, 0.92);
  }
  /* The sunrise strip's cells: 8 px, 1.5 px corners, 3 px apart; faint until lit. */
  /* Full width: whole cells, at least 3 px apart, the leftover shared between the gaps so the
     first and last cells sit flush with the label and the readout above them. */
  .cells {
    display: flex;
    justify-content: space-between;
    gap: 3px;
    margin-top: 10px;
  }
  .cell {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 1.5px;
    background: rgba(255, 255, 255, 0.16);
    transition:
      background-color 0.5s ease,
      scale 0.15s;
  }
  .cell.lit {
    background: rgba(255, 255, 255, 0.92);
  }
  .cell.next {
    animation: beat 1.6s ease-in-out infinite;
  }
  .cell.stop {
    background: var(--b-hot, #c9765a);
  }
  .cell:hover {
    scale: 1.35;
  }
  @keyframes beat {
    50% {
      background: rgba(255, 255, 255, 0.5);
    }
  }
  .head .beat {
    animation-name: beat-ink;
  }
  @keyframes beat-ink {
    50% {
      opacity: 0.25;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .head,
    .beat,
    .cell,
    .bento,
    .idle-copy,
    .head-wrap.opening {
      animation: none;
      transition: none;
    }
  }
</style>
