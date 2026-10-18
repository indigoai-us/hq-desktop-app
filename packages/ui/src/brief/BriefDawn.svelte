<script lang="ts">
  /**
   * The Create brief sunrise: a pixel horizon (6 px cells on an 8 px pitch,
   * after NewBotDawn and the brief's own sunrise widget) whose sun elevation
   * IS the run's progress. Stars fade and the sky warms in step; the step
   * text sits under the horizon. Ready plays one light bloom (the "ready"
   * feedback) and then calls `onbloomdone`. Failed holds the sun where the
   * run stopped and drains the color.
   *
   * Canvas only (no backdrop-filter). Reduced motion draws one static frame
   * per change and crossfades it.
   */
  import { onDestroy, onMount, type Snippet } from "svelte";
  import {
    bloomAt,
    clamp01,
    dawnDisplay,
    dawnLook,
    easeDawn,
    welcomeElevation,
    welcomeSky,
    welcomeSunRow,
    welcomeSunX,
    WELCOME_HOLD,
    WELCOME_HORIZON_Y,
    WELCOME_SEA_BOTTOM,
    WELCOME_SUN_R,
    type DawnPhase,
  } from "./brief-dawn.js";

  interface Props {
    progress: number;
    phase: DawnPhase;
    headline?: string;
    step?: string;
    /** Full page (empty state) or a shorter masthead over the brief. */
    size?: "page" | "masthead";
    /** Light opens from a dim warm grey. Dark is the night-to-dawn sky. */
    theme?: "dark" | "light";
    /** The mirrored sun in the water. The first-brief rise turns it off (round 11b). */
    reflection?: boolean;
    /** Centre: the sun mid-sky over a split page. Welcome: the round 11b sky beside the hero, with a striped sea. */
    layout?: "center" | "welcome";
    onbloomdone?: () => void;
    children?: Snippet;
  }
  let { progress, phase, headline = "", step = "", size = "page", theme = "dark", reflection = true, layout = "center", onbloomdone, children }: Props = $props();

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

  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const SUN_A = hex("#ffb580");
  const SUN_B = hex("#ff809f");
  const HALO = hex("#ffa88c");
  const HOR = hex("#ffbea0");
  const WATER = hex("#ff9696");
  const noise = (x: number, y: number) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  const grey = (c: number[], d: number) => {
    const l = 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
    return c.map((v) => Math.round(v + (l - v) * d));
  };

  /** Round 11b: diagonal sky over the whole page, the sun right of the hero, a striped sea, no reflection. */
  function drawWelcome(ctx: CanvasRenderingContext2D, W: number, H: number, bloom: number, drawn: number): void {
    const look = dawnLook(drawn, failedFade);
    const e = welcomeElevation(drawn);
    const light = theme === "light";
    const d = look.desaturate;
    const tint = (c: number[]) => (d > 0 ? grey(c, d) : c);
    const lit = clamp01(drawn / WELCOME_HOLD);
    const [s0, s1, s2] = welcomeSky(theme, lit).map(tint) as [number[], number[], number[]];
    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, `rgb(${s0.join(",")})`);
    bg.addColorStop(0.7, `rgb(${s1.join(",")})`);
    bg.addColorStop(1, `rgb(${s2.join(",")})`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const hz = Math.round(WELCOME_HORIZON_Y / 8);
    const cx = welcomeSunX(W) / 8;
    const R = WELCOME_SUN_R;
    const sy = welcomeSunRow(hz, e);
    const half = 37;
    const top = Math.max(0, hz - 32);
    const lightness = 0.45 + e * 0.55;
    const pulse = time * 5;
    for (let y = top; y <= hz; y++) {
      for (let x = Math.max(0, Math.floor(cx - half)); x <= Math.ceil(cx + half); x++) {
        if (x * 8 > W) break;
        const dx = x - cx;
        const dist = Math.hypot(dx, y - sy);
        let col: number[] = [255, 255, 255];
        let a = 0;
        if (y === hz) {
          const near = Math.max(0, 1 - Math.abs(dx) / (75 * 0.42));
          col = HOR;
          a = 0.1 + near * 0.3 * lightness;
        } else if (dist <= R) {
          const down = (y - sy + R) / (R * 2);
          col = [255, Math.round(181 - 53 * down), Math.round(128 + 31 * down)];
          a = down > 0.52 && Math.floor(y + time * 0.9) % 2 === 0 ? 0.28 : 0.9;
        } else {
          const n = noise(x, y);
          const halo = Math.max(0, 1 - (dist - R) / (R * 1.1));
          const wave = R + (pulse % (R * 2.2));
          const ring = !reduced && Math.abs(dist - wave) < 0.7 ? 0.1 * (1 - (wave - R) / (R * 2.2)) : 0;
          const star = n > 0.93 ? (0.2 + 0.3 * (0.5 + 0.5 * Math.sin(time * (1 + n * 2) + n * 40))) * (1 - e * 0.85) : 0;
          if (halo > 0 || ring > 0) col = HALO;
          const edge = Math.pow(Math.min(1, Math.min(x - (cx - half), cx + half - x) / 15), 2) * Math.pow(Math.min(1, (y - top) / 10), 2);
          const faint = 0.032 * edge * Math.exp(-Math.pow(dx / (75 * 0.43), 2));
          a = Math.max(faint, halo * halo * 0.34 * lightness + ring, star * edge);
        }
        if (light && y === hz) col = col.map((v) => Math.round(v * 0.85));
        if (a > 0.012) {
          const c = tint(col);
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
          ctx.fillRect(x * 8 + 1, y * 8 + 1, 6, 6);
        }
      }
    }
    // The striped sea runs edge to edge, every other row, and fades into the progress block.
    const sea = light ? [176, 100, 98] : [255, 150, 150];
    const seaTop = (hz + 1) * 8;
    for (let yy = seaTop; yy < Math.min(H, WELCOME_SEA_BOTTOM); yy += 16) {
      const fadeOut = Math.min(1, (WELCOME_SEA_BOTTOM - yy) / 16);
      const a = (light ? 0.4 : 0.26) * fadeOut * Math.max(0.5, lit);
      const c = tint(sea);
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
      for (let xx = 0; xx < W; xx += 8) ctx.fillRect(xx + 1, yy + 1, 6, 6);
    }
    if (bloom > 0) {
      const g = ctx.createRadialGradient(cx * 8, sy * 8, 0, cx * 8, sy * 8, Math.max(W, H) * 0.8);
      g.addColorStop(0, `rgba(255,236,214,${0.85 * bloom})`);
      g.addColorStop(1, `rgba(255,190,160,0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function draw(ctx: CanvasRenderingContext2D, W: number, H: number, bloom: number, drawn: number): void {
    if (layout === "welcome") return drawWelcome(ctx, W, H, bloom, drawn);
    const look = dawnLook(drawn, failedFade);
    const e = look.elevation;
    const cols = Math.floor(W / 8);
    const rows = Math.floor(H / 8);
    const hz = Math.floor(rows * (size === "page" ? 0.5 : 0.62));
    const R = Math.max(3, Math.min((hz - 2) / 2.4, cols * 0.09));
    const cx = cols * 0.5;
    // Below the horizon at 0, its top cresting near 0.25, fully up at 1.
    const sy = hz + R * 1.15 - e * (hz * 0.62 + R);
    const d = look.desaturate;
    const tint = (c: number[]) => (d > 0 ? grey(c, d) : c);
    ctx.clearRect(0, 0, W, H);
    const light = theme === "light";
    const sky = ctx.createLinearGradient(0, 0, 0, hz * 8);
    const top = light
      ? tint([236, 228 - 8 * look.warmth, 220 - 12 * look.warmth])
      : tint([20 + 18 * look.warmth, 20 + 10 * look.warmth, 28 + 6 * look.warmth]);
    const low = light
      ? tint([255, 214 + 16 * look.warmth, 196])
      : tint([34 + 90 * look.warmth, 30 + 44 * look.warmth, 38 + 24 * look.warmth]);
    sky.addColorStop(0, `rgb(${top.join(",")})`);
    sky.addColorStop(1, `rgb(${low.join(",")})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hz * 8);
    ctx.fillStyle = light ? "#f4efe9" : "#121216";
    ctx.fillRect(0, hz * 8, W, H - hz * 8);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let col: number[] | null = null;
        let a = 0;
        if (y < hz) {
          const dist = Math.hypot(x - cx, (y - sy) * 1.05);
          if (dist < R) {
            col = mix(SUN_A, SUN_B, clamp01((y - (sy - R)) / (2 * R)));
            a = 1;
          } else if (dist < R + 2.6) {
            col = HALO;
            a = (0.28 + 0.12 * Math.sin(time * 1.4)) * (1 - (dist - R) / 2.6) * (0.4 + 0.6 * e);
          } else {
            const n = noise(x, y);
            if (n < 0.022 && y < hz * 0.72) {
              col = [255, 255, 255];
              a = look.stars * (0.1 + 0.16 * Math.sin(time * 1.1 + n * 90) ** 2);
            } else {
              col = [255, 255, 255];
              a = 0.02;
            }
          }
          if (y === hz - 1) {
            col = HOR;
            a = Math.max(a, 0.22 + 0.55 * e);
          }
          // The warm glow below the horizon before the sun shows.
          if (y >= hz - 3 && Math.abs(x - cx) < R * 2.2) {
            const g = (1 - Math.abs(x - cx) / (R * 2.2)) * (0.1 + 0.25 * (1 - e)) * (y - hz + 4) / 4;
            if (g > a * 0.6 && col !== null && dist >= R) {
              col = HALO;
              a = Math.max(a, g);
            }
          }
        } else {
          const depth = y - hz;
          const my = 2 * hz - y - 1;
          const sway = Math.sin(time * 1.6 + y * 0.7) * (1 + depth * 0.08);
          const dist = Math.hypot(x + sway - cx, (my - sy) * 1.05);
          if (reflection && dist < R && (y % 2 === 0 || depth < 3)) {
            col = WATER;
            a = Math.max(0.06, 0.6 - depth * 0.045) * (0.3 + 0.7 * e);
          } else {
            col = [255, 255, 255];
            a = 0.016;
          }
        }
        if (col && a > 0.004) {
          const c = tint(col);
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
          ctx.fillRect(x * 8 + 1, y * 8 + 1, 6, 6);
        }
      }
    }
    if (bloom > 0) {
      const g = ctx.createRadialGradient(cx * 8, sy * 8, 0, cx * 8, sy * 8, Math.max(W, H) * 0.8);
      g.addColorStop(0, `rgba(255,236,214,${0.85 * bloom})`);
      g.addColorStop(1, `rgba(255,190,160,0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /**
   * Set on destroy. The bloom callback can unmount this component from inside
   * a frame (the page swaps the sunrise for the brief), so the frame that fired
   * it must not read its props again or schedule another one.
   */
  let destroyed = false;

  function frame(now: number): void {
    if (destroyed) return;
    const el = canvas;
    const box = host;
    if (!el || !box) return;
    const W = box.clientWidth;
    const H = box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
      el.width = Math.round(W * dpr);
      el.height = Math.round(H * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Read the props once: `onbloomdone` below may unmount this component and
    // the host's prop getters are not safe to call after that.
    const ph = phase;
    const pr = progress;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    time += dt;
    const target = ph === "ready" ? 1 : ph === "idle" ? 0 : pr;
    // Failed: the sun holds where the run stopped.
    if (ph !== "failed") shown = easeDawn(shown, target, dt, time, reduced);
    else if (reduced) shown = clamp01(pr);
    failedFade = ph === "failed" ? (reduced ? 1 : Math.min(1, failedFade + dt * 1.2)) : 0;
    let bloom = 0;
    if (ph === "ready" && (reduced || shown > 0.97)) {
      bloomStart ??= now;
      bloom = reduced ? 0 : bloomAt(now - bloomStart);
      if (!bloomFired && (reduced || now - bloomStart >= 900)) {
        bloomFired = true;
        onbloomdone?.();
        if (destroyed) return;
      }
    }
    draw(ctx, W, H, bloom, ph === "failed" ? shown : dawnDisplay(shown, target, time, reduced));
    if (!reduced && !destroyed) raf = requestAnimationFrame(frame);
  }

  onMount(() => {
    reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof requestAnimationFrame !== "function") return;
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

  onDestroy(() => {
    destroyed = true;
    cancelAnimationFrame(raf);
  });
</script>

<div
  class="dawn {size}"
  class:welcome={layout === "welcome"}
  class:failed={phase === "failed"}
  data-testid="brief-dawn"
  data-phase={phase}
  data-progress={progress.toFixed(2)}
  data-layout={layout}
>
  <!-- The sky keeps its own fixed height; the card grows below it to fit the copy. -->
  <div class="sky" bind:this={host}><canvas bind:this={canvas} class:fade aria-hidden="true"></canvas></div>
  <div class="copy">
    {#if headline}<h2>{headline}</h2>{/if}
    {#if step}<p class="step" aria-live="polite" data-testid="brief-dawn-step">{step}</p>{/if}
    {#if children}<div class="actions">{@render children()}</div>{/if}
  </div>
</div>

<style>
  .dawn {
    position: relative;
    overflow: hidden;
    border-radius: var(--b-r, 22px);
    background: #121216;
    min-height: var(--sky-h);
  }
  .dawn.welcome {
    background: transparent;
  }
  .dawn.page {
    --sky-h: max(420px, min(680px, calc(100vh - 120px)));
  }
  .dawn.masthead {
    --sky-h: 260px;
    margin-bottom: var(--b-gap, 14px);
  }
  .sky {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--sky-h);
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
  /* In flow, so a long loader grows the card instead of being clipped. */
  .copy {
    position: relative;
    padding: calc(var(--sky-h) * 0.54) 24px 22px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
  }
  .masthead .copy {
    padding-top: calc(var(--sky-h) * 0.64);
    gap: 6px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: rgba(255, 255, 255, 0.95);
  }
  .step {
    margin: 0;
    font-family: var(--b-mono, ui-monospace, monospace);
    font-size: 13px;
    color: rgba(255, 210, 190, 0.8);
  }
  .failed .step {
    color: rgba(255, 255, 255, 0.6);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
    width: 100%;
  }
</style>
