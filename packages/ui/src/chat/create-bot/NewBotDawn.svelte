<script lang="ts" module>
  export type DawnMode = "creating" | "waking" | "waiting" | "ready" | "failed";

  /** Size of one square of the matrix and the gap around it, in CSS pixels. */
  export const DAWN_CELL = 6;
  export const DAWN_PITCH = 8;

  /** Stable per-cell noise in [0, 1): the same cell always twinkles the same way. */
  export function dawnNoise(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  /**
   * Where the sun sits for a progress in [0, 1], in matrix rows. At 0 only its
   * crown clears the horizon; at 1 the whole disc is up with room under it.
   */
  export function dawnSunRow(progress: number, horizonRow: number, radius: number): number {
    const p = Math.min(1, Math.max(0, progress));
    const eased = 1 - Math.pow(1 - p, 2.2);
    const start = horizonRow + radius * 0.55;
    const end = horizonRow - radius * 1.2;
    return start + (end - start) * eased;
  }

  /**
   * How fast the drawn sun closes on its target, per second (an exponential
   * ease). While the create request is in flight the target is set once and
   * the sun creeps to it over a few seconds; every other mode follows real
   * progress briskly.
   */
  export function dawnEaseRate(mode: DawnMode): number {
    return mode === "creating" ? 0.6 : 2.4;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    /** 0 to 100. The sun rises with it. */
    progress: number;
    mode?: DawnMode;
    /** Accessible name of the progress bar this drawing stands for. */
    label: string;
  }

  let { progress, mode = "waking", label }: Props = $props();

  let frame = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);

  // Plain variables on purpose: the draw loop reads them every frame and none
  // of them should schedule a Svelte update.
  let shown = Math.max(0, Math.min(100, progress)) / 100;
  let target = shown;
  let currentMode: DawnMode = mode;
  let redraw: (() => void) | null = null;

  $effect(() => {
    target = Math.max(0, Math.min(100, progress)) / 100;
    currentMode = mode;
    redraw?.();
  });

  onMount(() => {
    const el = canvas;
    const host = frame;
    const ctx = el?.getContext?.("2d") ?? null;
    if (!el || !host || !ctx) return;

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const born = performance.now();
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let raf = 0;
    let last = born;

    function measure(): void {
      const box = host!.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.floor(box.width));
      height = Math.max(1, Math.floor(box.height));
      el!.width = Math.floor(width * ratio);
      el!.height = Math.floor(height * ratio);
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
      cols = Math.max(1, Math.floor(width / DAWN_PITCH));
      rows = Math.max(1, Math.floor(height / DAWN_PITCH));
    }

    function draw(now: number): void {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      shown = still ? target : shown + (target - shown) * (1 - Math.exp(-dt * dawnEaseRate(currentMode)));
      const failed = currentMode === "failed";
      const ready = currentMode === "ready";
      const waiting = currentMode === "waiting";
      // Seconds on a shared clock, so a remount picks the motion up mid-beat.
      const t = still || failed ? 0 : now / 1000;
      const arrive = still ? 1 : Math.min(1, (now - born) / 900);

      ctx!.clearRect(0, 0, width, height);
      const offsetX = (width - cols * DAWN_PITCH + (DAWN_PITCH - DAWN_CELL)) / 2;
      const horizon = Math.round(rows * 0.64);
      // Small enough that the risen disc clears the horizon and still leaves
      // sky above it: the sky is `horizon` rows tall.
      const radius = Math.max(3, Math.min((horizon - 2) / 2.3, cols * 0.14));
      const sunX = (cols - 1) / 2;
      const sunY = dawnSunRow(shown, horizon, radius);
      const light = failed ? 0.25 : 0.45 + shown * 0.55;
      const breath = waiting ? 0.5 + 0.5 * Math.sin(t * 1.4) : 1;
      const wave = waiting || ready || failed ? -1 : radius + ((t * 5) % (radius * 2.2));
      const maxReach = Math.hypot(cols / 2, rows);

      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const dx = x - sunX;
          const dy = y - sunY;
          const d = Math.hypot(dx, dy);
          const noise = dawnNoise(x, y);
          // Cells light up outward from the sun as the drawing arrives.
          const reveal = Math.min(1, Math.max(0, arrive * 1.5 - (d / maxReach) * 0.5));
          // Fade the matrix out toward the left and right edges.
          const edge =
            Math.min(1, Math.min(x, cols - 1 - x) / (cols * 0.14)) *
            Math.min(1, (y + 1) / 4, (rows - y) / 3);
          let r = 255;
          let g = 255;
          let b = 255;
          let alpha = 0.032;

          if (y < horizon) {
            if (d <= radius) {
              // The disc: orange at the crown, pink toward the horizon, with
              // the slow horizontal bands of a low sun.
              const down = (dy + radius) / (radius * 2);
              const band = down > 0.52 && Math.floor(y + t * 0.9) % 2 === 0;
              r = 255;
              g = Math.round(181 - 53 * down);
              b = Math.round(128 + 31 * down);
              alpha = band ? 0.28 : 0.9 + 0.1 * Math.sin(t * 2 + noise * 6.28);
              alpha *= 0.55 + 0.45 * breath;
            } else {
              const halo = Math.max(0, 1 - (d - radius) / (radius * 1.1));
              const star = noise > 0.93 ? (0.2 + 0.3 * (0.5 + 0.5 * Math.sin(t * (1 + noise * 2) + noise * 40))) * (1 - shown * 0.85) : 0;
              const ring = wave > 0 && Math.abs(d - wave) < 0.7 ? 0.1 * (1 - (wave - radius) / (radius * 2.2)) : 0;
              const sky = ready ? 0.07 : 0;
              if (halo > 0 || ring > 0 || sky > 0) {
                r = 255;
                g = 168;
                b = 140;
              }
              alpha = Math.max(alpha, halo * halo * 0.34 * light * breath + ring + sky, star);
            }
          } else if (y === horizon) {
            const near = Math.max(0, 1 - Math.abs(dx) / (cols * 0.42));
            r = 255;
            g = 190;
            b = 160;
            alpha = 0.1 + near * 0.3 * light;
          } else {
            // Water: the disc mirrored and stretched, broken into drifting streaks.
            const depth = y - horizon;
            const sway = Math.sin(t * 1.3 + depth * 0.9) * depth * 0.22;
            const mirrored = Math.hypot(dx + sway, horizon - depth * 0.7 - sunY);
            const fade = 1 - depth / Math.max(1, rows - horizon);
            if (mirrored <= radius && (depth + Math.floor(t * 1.6)) % 2 === 0) {
              r = 255;
              g = 150;
              b = 150;
              alpha = (0.26 + 0.34 * fade) * light * (0.6 + 0.4 * breath);
            } else {
              alpha = 0.03 + 0.02 * fade;
            }
          }

          if (failed) {
            const grey = Math.round((r + g + b) / 3);
            r = grey;
            g = grey;
            b = grey;
            alpha *= 0.7;
          }
          alpha *= reveal * (0.15 + 0.85 * edge);
          if (alpha < 0.012) continue;
          ctx!.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
          ctx!.fillRect(offsetX + x * DAWN_PITCH, y * DAWN_PITCH, DAWN_CELL, DAWN_CELL);
        }
      }
    }

    function loop(now: number): void {
      draw(now);
      raf = requestAnimationFrame(loop);
    }

    measure();
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            measure();
            if (still) draw(performance.now());
          })
        : null;
    observer?.observe(host);

    if (still) {
      redraw = () => draw(performance.now());
      draw(performance.now());
    } else {
      // One frame right away, so there is a drawing even before the first
      // animation frame (a window in the background gets none).
      draw(performance.now());
      raf = requestAnimationFrame(loop);
    }

    return () => {
      redraw = null;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  });
</script>

<div
  bind:this={frame}
  class="new-bot-dawn"
  class:failed={mode === "failed"}
  data-testid="new-bot-waking-ring"
  data-mode={mode}
  role="progressbar"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow={Math.round(Math.max(0, Math.min(100, progress)))}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>
