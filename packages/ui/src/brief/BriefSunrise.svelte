<script lang="ts">
  /**
   * Pixel sunrise: progress of today's decisions. The sun rises one step per
   * decision cleared, a ripple runs out from it on each clear, and hovering
   * shows a ghost sun where clearing every decision takes you. Same matrix and
   * palette as Stefan's NewBotDawn (6 px cells on an 8 px pitch).
   */
  import { onMount } from "svelte";
  import { DAWN_CELL, DAWN_PITCH, dawnNoise } from "../chat/create-bot/NewBotDawn.svelte";
  import { useBrief } from "./brief-context.svelte.js";

  interface Props {
    total: number;
    cleared: number;
    userName: string;
    sub: string;
    /** Line shown when nothing is owed. */
    quietLine: string;
    big?: boolean;
    /** Yesterday's sessions for the timeline, when the card is tall. */
    timeline?: { at: string; title: string }[];
  }
  let { total, cleared, userName, sub, quietLine, big = false, timeline = [] }: Props = $props();
  const brief = useBrief();

  const left = $derived(total - cleared);
  const line = $derived(
    !total ? quietLine : left > 0 ? `${left} call${left > 1 ? "s" : ""} before sunrise.` : "Sun's up. Go build.",
  );
  const progress = $derived(total ? 0.1 + (0.9 * cleared) / total : 1);

  let host = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  // Read by the draw loop every frame; none should schedule a Svelte update.
  let target = 0.1;
  let hover = false;
  let ripples: number[] = [];
  let clock = 0;
  let redraw: (() => void) | null = null;
  let lastRipple = 0;

  $effect(() => {
    target = progress;
    if (brief.ripple !== lastRipple) {
      lastRipple = brief.ripple;
      ripples.push(clock);
    }
    redraw?.();
  });

  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const SUN_A = hex("#FFB580");
  const SUN_B = hex("#FF809F");
  const HALO = hex("#FFA88C");
  const HOR = hex("#FFBEA0");
  const WATER = hex("#FF9696");
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));

  function timeX(iso: string): number {
    const d = new Date(iso);
    const h = d.getHours() + d.getMinutes() / 60;
    return 8 + ((Math.min(22, Math.max(12, h)) - 12) / 10) * 344;
  }

  onMount(() => {
    const el = canvas;
    const box = host;
    const ctx = el?.getContext?.("2d") ?? null;
    if (!el || !box || !ctx) return;
    lastRipple = brief.ripple;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let shown = still ? target : 0.1;
    let raf = 0;
    let last = performance.now();
    let width = 0;
    let height = 0;

    function measure(): void {
      const r = box!.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.floor(r.width));
      height = Math.max(1, Math.floor(r.height));
      el!.width = Math.floor(width * ratio);
      el!.height = Math.floor(height * ratio);
      ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function draw(now: number): void {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;
      shown = still ? target : shown + (target - shown) * (1 - Math.exp(-dt * 2.4));
      const cols = Math.floor(width / DAWN_PITCH);
      const rows = Math.floor(height / DAWN_PITCH);
      const hz = Math.floor(rows * 0.64);
      const R = Math.max(3, Math.min((hz - 2) / 2.3, cols * 0.14));
      const cx = cols * 0.68;
      const e = 1 - Math.pow(1 - shown, 2.2);
      const sy = hz + R * 0.55 - e * (hz * 0.55);
      const breathe = left > 0 && !still ? 0.5 + 0.5 * Math.sin(1.4 * clock) : 1;
      ctx!.clearRect(0, 0, width, height);
      const sky = ctx!.createLinearGradient(0, 0, 0, hz * DAWN_PITCH);
      sky.addColorStop(0, "rgba(20,20,30,1)");
      sky.addColorStop(1, `rgba(${60 + e * 60},${30 + e * 25},${45 + e * 10},1)`);
      ctx!.fillStyle = sky;
      ctx!.fillRect(0, 0, width, hz * DAWN_PITCH);
      ctx!.fillStyle = "#121216";
      ctx!.fillRect(0, hz * DAWN_PITCH, width, height);
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          let col = [255, 255, 255];
          let a = 0;
          if (y < hz) {
            const d = Math.hypot(x - cx, (y - sy) * 1.05);
            if (d < R) {
              col = mix(SUN_A, SUN_B, Math.max(0, Math.min(1, (y - (sy - R)) / (2 * R))));
              a = 1;
            } else if (d < R + 2.4) {
              col = HALO;
              a = (0.32 + 0.18 * breathe) * (1 - (d - R) / 2.4);
            } else {
              const n = dawnNoise(x, y);
              a = n < 0.07 && y < hz * 0.7 && x > cols * 0.6 ? (1 - e) * (0.12 + 0.16 * Math.sin(clock * 1.3 + n * 80) ** 2) : 0.022;
            }
            for (const t0 of ripples) {
              const rr = (clock - t0) * 15;
              if (Math.abs(d - rr) < 1.2 && rr < cols) {
                col = HALO;
                a = Math.max(a, 0.55 * (1 - rr / cols));
              }
            }
            if (y === hz - 1) {
              col = HOR;
              a = Math.max(a, 0.35 + 0.5 * e);
            }
          } else {
            const depth = y - hz;
            const my = 2 * hz - y - 1;
            const sway = still ? 0 : Math.sin(clock * 1.6 + y * 0.7) * (1 + depth * 0.08);
            const d = Math.hypot(x + sway - cx, (my - sy) * 1.05);
            if (d < R && (y % 2 === 0 || depth < 3)) {
              col = WATER;
              a = Math.max(0.08, 0.7 - depth * 0.045) * (0.6 + 0.4 * e);
            } else a = 0.018;
          }
          if (a > 0.004) {
            ctx!.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
            ctx!.fillRect(x * DAWN_PITCH + 1, y * DAWN_PITCH + 1, DAWN_CELL, DAWN_CELL);
          }
        }
      }
      if (hover && total) {
        const gy = hz + R * 0.55 - hz * 0.55;
        ctx!.strokeStyle = "rgba(255,190,160,.6)";
        ctx!.setLineDash([3, 4]);
        ctx!.beginPath();
        ctx!.arc(cx * DAWN_PITCH + 4, gy * DAWN_PITCH + 4, R * DAWN_PITCH, 0, Math.PI * 2);
        ctx!.stroke();
        ctx!.setLineDash([]);
        ctx!.fillStyle = "rgba(255,190,160,.85)";
        ctx!.font = "500 10px 'Geist Mono', ui-monospace, monospace";
        ctx!.textAlign = "center";
        ctx!.fillText("ALL CLEAR", cx * DAWN_PITCH + 4, gy * DAWN_PITCH - R * DAWN_PITCH - 6);
      }
      ripples = ripples.filter((t0) => clock - t0 < 4);
      if (!still) raf = requestAnimationFrame(draw);
    }

    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { measure(); if (still) draw(performance.now()); });
    ro?.observe(box);
    redraw = still ? () => draw(performance.now()) : null;
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      redraw = null;
    };
  });
</script>

<div
  class="w dawn"
  bind:this={host}
  data-testid="brief-sunrise"
  role="progressbar"
  aria-label="Decisions cleared today"
  aria-valuemin="0"
  aria-valuemax={total}
  aria-valuenow={cleared}
  onpointerenter={() => (hover = true)}
  onpointerleave={() => (hover = false)}
>
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
  <div class="over">
    <div class="eyebrow" style="color:rgba(255,190,160,.7)">Sunrise · {total ? "decisions cleared" : "nothing owed"}</div>
    <div class="greet" class:big>
      Morning{userName ? `, ${userName}` : ""}.<br /><span>{line}</span>
    </div>
    <div class="sub" style="margin-top:12px;max-width:{big ? 420 : 330}px">{sub}</div>
    {#if timeline.length}
      <div class="tl">
        <div class="eyebrow" style="color:rgba(255,190,160,.6)">Yesterday · {timeline.length} sessions</div>
        <svg viewBox="0 0 360 44" aria-hidden="true">
          <line class="ln" x1="8" y1="26" x2="352" y2="26" stroke="rgba(255,190,160,.35)" stroke-width="1.5" />
          {#each [12, 14, 16, 18, 20, 22] as h (h)}
            <text x={8 + ((h - 12) / 10) * 344} y="42" fill="rgba(255,255,255,.3)" font-size="8.5" text-anchor="middle">{h}:00</text>
          {/each}
          {#each timeline as s, i (i)}
            <g class="s">
              <circle cx={timeX(s.at)} cy="26" r="4" fill="#ffb580" style="animation-delay:{0.8 + i * 0.12}s" class="sd" />
              <text x={timeX(s.at)} y="12" fill="#fff" font-size="9.5" text-anchor={i > timeline.length - 3 ? "end" : i < 1 ? "start" : "middle"}>{s.title}</text>
            </g>
          {/each}
        </svg>
      </div>
    {/if}
    <div class="meter">
      <div class="track"><i style="width:{total ? (cleared / total) * 100 : 100}%"></i></div>
      <b>{total ? `${cleared} / ${total}` : "CLEAR"}</b>
    </div>
  </div>
</div>

<style>
  .dawn {
    padding: 0;
    background: #141418;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .over {
    position: relative;
    padding: 22px 24px;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .greet {
    font-size: 32px;
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin-top: 12px;
  }
  .greet.big {
    font-size: 40px;
  }
  .greet span {
    color: #ffb580;
  }
  .tl {
    margin-top: auto;
    margin-bottom: 12px;
  }
  .tl svg {
    display: block;
    width: 100%;
    height: 44px;
    overflow: visible;
    font-family: var(--b-mono);
  }
  .tl .ln {
    stroke-dasharray: 400;
    stroke-dashoffset: 400;
    animation: draw 1.6s cubic-bezier(0.2, 0.8, 0.2, 1) 0.6s forwards;
  }
  .tl .sd {
    opacity: 0;
    animation: pop 0.4s cubic-bezier(0.3, 1.6, 0.5, 1) forwards;
    transform-box: fill-box;
    transform-origin: center;
  }
  .tl g.s text {
    opacity: 0;
    transition: opacity 0.2s;
  }
  .tl g.s:hover text {
    opacity: 1;
  }
  .tl g.s:hover .sd {
    fill: #fff;
  }
  @keyframes draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.2);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tl .sd {
      opacity: 1;
    }
    .tl .ln {
      stroke-dashoffset: 0;
    }
  }
  .meter {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .tl + .meter {
    margin-top: 0;
  }
  .track {
    flex: 1;
    height: 8px;
    border-radius: 99px;
    background: rgba(0, 0, 0, 0.35);
    box-shadow: inset 2px 2px 5px rgba(0, 0, 0, 0.6);
  }
  .track i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #ffb580, #ff809f);
    box-shadow: 0 0 14px rgba(255, 150, 140, 0.55);
    transition: width 1.1s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .meter b {
    font-family: var(--b-mono);
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.56);
  }
</style>
