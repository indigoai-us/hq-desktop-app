<script lang="ts">
  /**
   * Pixel sunrise: progress of today's decisions. The sun rises one step per
   * decision cleared, a ripple runs out from it on each clear, and hovering
   * shows a ghost sun where clearing every decision takes you. Same matrix and
   * palette as Stefan's NewBotDawn (6 px cells on an 8 px pitch). Under the
   * greeting, "First: ..." names priority 1 (XL and L only); the last 24 hours
   * of your sessions are dots with a hover card; the meter shows cleared of
   * total and, when the writer sized the decisions, "~N min" to clear them.
   */
  import { onMount } from "svelte";
  import { DAWN_CELL, DAWN_PITCH, dawnNoise } from "../chat/create-bot/NewBotDawn.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { etaLabel, firstLine, type HeroLead } from "./brief-hero.js";
  import { distillTimeline, sessionPeek, sessionTitle, type Timeline, type TimelineSession } from "./brief-timeline.js";

  interface Props {
    total: number;
    cleared: number;
    userName: string;
    sub: string;
    /** Line shown when nothing is owed. */
    quietLine: string;
    big?: boolean;
    /** Sessions from the 24 hours before `now`, oldest first. Ignored when `distilled` is given. */
    timeline?: TimelineSession[];
    /** The same sessions already distilled by the page, so the strip is not distilled twice. */
    distilled?: Timeline | null;
    /** End of the timeline window (ISO). */
    now?: string;
    /** Priority 1 in the writer's words; shown as "First: ..." at XL and L, hidden at M. */
    lead?: HeroLead | null;
    /** Minutes to clear every open decision (writer's sum of effort sizes); shown beside the meter as "~N min". */
    timeToClearMin?: number | null;
    /** Say "Morning, name." above the line; off when the page greets in its own header. */
    greet?: boolean;
  }
  let {
    total,
    cleared,
    userName,
    sub,
    quietLine,
    big = false,
    timeline = [],
    distilled = null,
    now = new Date().toISOString(),
    lead = null,
    timeToClearMin = null,
    greet = true,
  }: Props = $props();
  const leadLine = $derived(firstLine(lead));
  const end = $derived(Date.parse(now));
  const tl = $derived(distilled ?? distillTimeline(timeline, now));
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // One dot per session; hover opens the session card with Resume and Copy prompt.
  const dotPeek = (s: TimelineSession, i: number): PeekContent => sessionPeek(s, i, tl.items.length);
  // Hour ticks every 6h across the window, labelled in local time.
  const ticks = $derived(
    [24, 18, 12, 6, 0].map((back) => {
      const t = end - back * 3600_000;
      const d = new Date(t);
      return { pct: ((24 - back) / 24) * 100, label: back === 0 ? "now" : `${d.getHours() % 12 || 12} ${d.getHours() >= 12 ? "PM" : "AM"}` };
    }),
  );
  // The strip: one column per hour of the window, each session a lit cell stacked in its hour.
  const hours = $derived.by(() => {
    const cols: { s: TimelineSession; i: number }[][] = Array.from({ length: 24 }, () => []);
    tl.items.forEach((s, i) => {
      const h = Math.floor((Date.parse(s.at) - (end - 24 * 3600_000)) / 3600_000);
      cols[Math.max(0, Math.min(23, h))]!.push({ s, i });
    });
    return cols;
  });
  const busiest = $derived.by(() => {
    let best = -1;
    hours.forEach((c, h) => {
      if (c.length > 1 && (best < 0 || c.length > hours[best]!.length)) best = h;
    });
    if (best < 0) return "";
    const d = new Date(end - (24 - best) * 3600_000);
    return `busiest ${d.toLocaleTimeString([], { hour: "numeric" }).replace(/\s/g, " ")}`;
  });
  const brief = useBrief();

  const left = $derived(total - cleared);
  const line = $derived(
    !total ? quietLine : left > 0 ? `${left} decision${left > 1 ? "s" : ""} before sunrise.` : "Sun's up. Go build.",
  );
  // The brand's one italic accent: the count while decisions are open, the call to build once clear.
  const lineParts = $derived(
    !total
      ? { pre: quietLine, em: "", post: "" }
      : left > 0
        ? { pre: "", em: `${left} decision${left > 1 ? "s" : ""}`, post: " before sunrise." }
        : { pre: "Sun's up. ", em: "Go build.", post: "" },
  );
  const progress = $derived(total ? 0.1 + (0.9 * cleared) / total : 1);
  // "~N min" to clear what is left, from the writer's effort sizes; nothing when unknown or done.
  const eta = $derived(etaLabel(timeToClearMin, left, total));

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
  // Drawn in light over the card's dusk field: a cream sun, white halo and horizon.
  const SUN_A = hex("#FFFBF2");
  const SUN_B = hex("#FFD6C2");
  const HALO = hex("#FFFFFF");
  const HOR = hex("#FFFFFF");
  const WATER = hex("#FFE9DE");
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));


  onMount(() => {
    const el = canvas;
    const box = host;
    const ctx = el?.getContext?.("2d") ?? null;
    if (!el || !box || !ctx) return;
    lastRipple = brief.ripple;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let shown = still ? target : 0.1;
    // 0..1: how far the "all clear" glow has faded in under the pointer.
    let ghost = 0;
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
      const want = hover && total && cleared < total ? 1 : 0;
      ghost = still ? want : ghost + (want - ghost) * (1 - Math.exp(-dt * 6));
      const cols = Math.floor(width / DAWN_PITCH);
      const rows = Math.floor(height / DAWN_PITCH);
      const hz = Math.floor(rows * 0.64);
      const R = Math.max(3, Math.min((hz - 2) / 2.3, cols * 0.14));
      const cx = cols * 0.68;
      const e = 1 - Math.pow(1 - shown, 2.2);
      const sy = hz + R * 0.55 - e * (hz * 0.55);
      const breathe = left > 0 && !still ? 0.5 + 0.5 * Math.sin(1.4 * clock) : 1;
      // Where the sun sits once every decision is cleared.
      const gy = hz + R * 0.55 - hz * 0.55;
      ctx!.clearRect(0, 0, width, height);
      const sky = ctx!.createLinearGradient(0, 0, 0, hz * DAWN_PITCH);
      // The sky is the card's own gradient; clearing decisions only warms the horizon.
      sky.addColorStop(0, "rgba(255,255,255,0)");
      sky.addColorStop(1, `rgba(255,236,220,${0.06 + e * 0.16})`);
      ctx!.fillStyle = sky;
      ctx!.fillRect(0, 0, width, hz * DAWN_PITCH);
      ctx!.fillStyle = "rgba(40,14,60,0.22)";
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
            // Hover: the mosaic brightens a little where the sun ends up when all is clear.
            if (ghost > 0.01) {
              const g = Math.hypot(x - cx, (y - gy) * 1.05);
              if (g < R + 1.5 && d >= R) {
                const edge = Math.max(0, Math.min(1, (R + 1.5 - g) / 1.5));
                a = Math.max(a, ghost * (0.07 + 0.09 * (1 - g / (R + 1.5))) * edge);
              }
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
      if (ghost > 0.01) {
        ctx!.fillStyle = `rgba(255,255,255,${0.85 * ghost})`;
        ctx!.font = "500 10px 'Geist Mono', ui-monospace, monospace";
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        // In the middle of the glow, where the sun lands once everything is cleared.
        ctx!.fillText("ALL CLEAR", cx * DAWN_PITCH + 4, gy * DAWN_PITCH + 4);
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
    <div class="eyebrow" style="color:rgba(255,255,255,.8)">Sunrise · {total ? "decisions cleared" : "nothing owed"}</div>
    <div class="greet" class:big>
      {#if greet}Morning{userName ? `, ${userName}` : ""}.<br />{/if}<span class="line" aria-label={line}>{lineParts.pre}{#if lineParts.em}<em class="accent-word">{lineParts.em}</em>{/if}{lineParts.post}</span>
    </div>
    {#if big && leadLine}<div class="first" data-testid="brief-sunrise-first">{leadLine}</div>{/if}
    <div class="sub lede" class:big>{sub}</div>
    <div class="tl">
      <div class="tl-head" data-testid="brief-timeline-head" data-hidden={tl.background ? `${tl.background} background session${tl.background === 1 ? "" : "s"} hidden` : undefined}>
        <span class="eyebrow">Last 24h · {tl.work ? `${tl.work} session${tl.work === 1 ? "" : "s"}` : "no sessions"}</span>
        {#if busiest}<span class="tl-meta">{busiest}</span>{/if}
      </div>
      <!-- A pixel strip in the card's mosaic: 24 hour columns, each session a lit cell; the latest is warm. -->
      <div class="cells">
        {#each hours as col, h (h)}
          <div class="hour" class:now={h === 23}>
            <span class="base" aria-hidden="true"></span>
            {#each col as { s: it, i } (it.id ?? `${it.at}-${i}`)}
              <button
                type="button"
                class="dot"
                class:last={i === tl.items.length - 1}
                style="animation-delay:{0.6 + i * 0.05}s"
                aria-label="{hhmm(it.at)} {sessionTitle(it.title)}"
                data-testid="brief-session-dot"
                use:peek={{ state: brief, content: () => dotPeek(it, i) }}
              ><span class="tip" class:end={h > 17} class:start={h < 6}>{hhmm(it.at)} {sessionTitle(it.title)}</span></button>
            {/each}
          </div>
        {/each}
      </div>
      <div class="ticks" aria-hidden="true">
        {#each ticks as t (t.label)}
          <span class="tick" class:start={t.pct === 0} class:end={t.label === "now"} style="left:{t.pct}%">{t.label}</span>
        {/each}
      </div>
    </div>
    <div class="meter">
      <div class="track"><i style="width:{total ? (cleared / total) * 100 : 100}%"></i></div>
      <b>{total ? `${cleared} / ${total}` : "CLEAR"}</b>
      {#if eta}<span class="eta" data-testid="brief-sunrise-eta">{eta}</span>{/if}
    </div>
  </div>
</div>

<style>
  .dawn {
    padding: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .over {
    position: relative;
    padding: var(--b-pad);
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .greet {
    font-size: var(--b-fs-display-sm);
    font-weight: 500;
    letter-spacing: var(--b-display-track);
    line-height: 1.04;
    margin-top: 12px;
  }
  .greet.big {
    font-size: var(--b-fs-display);
  }
  .greet .line {
    color: #fff;
  }
  .greet :global(.accent-word) {
    font-weight: 400;
  }
  /* Text stays left of the sun (drawn at 68% of the width, radius up to 14%), so it never runs over it. */
  .first {
    margin-top: 10px;
    max-width: min(440px, calc(54% - 32px));
    font-size: 13px;
    line-height: 1.35;
    color: rgb(var(--b-ink) / 0.86);
  }
  /* Muted under the headline. */
  .over .lede {
    color: rgba(255, 255, 255, 0.72);
  }
  .lede {
    margin-top: 12px;
    text-shadow: 0 1px 3px rgba(40, 10, 50, 0.35);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    max-width: min(330px, calc(54% - 32px));
  }
  .lede.big {
    max-width: min(420px, calc(54% - 32px));
  }
  /* The timeline sits at the bottom with a guaranteed gap above it, so the lede never touches its label. */
  .tl {
    margin-top: auto;
    padding-top: 18px;
    margin-bottom: 12px;
  }
  .tl-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    white-space: nowrap;
  }
  .tl-head .eyebrow {
    color: rgba(255, 255, 255, 0.85);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tl-meta {
    font-family: var(--b-code);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
  }
  /* Square cells on the mosaic's rhythm, sitting on a faint row of empty hours. */
  .cells {
    display: grid;
    grid-template-columns: repeat(24, minmax(0, 1fr));
    align-items: end;
    gap: 3px;
    height: 44px;
    margin-top: 12px;
  }
  .hour {
    display: flex;
    flex-direction: column-reverse;
    align-items: center;
    gap: 3px;
  }
  .hour > * {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 1.5px;
  }
  .base {
    display: block;
    background: rgba(255, 255, 255, 0.16);
  }
  .hour:has(.dot) .base {
    display: none;
  }
  .hour.now .base {
    background: rgba(255, 255, 255, 0.4);
  }
  .dot {
    position: relative;
    display: block;
    padding: 0;
    border: 0;
    background: rgba(255, 255, 255, 0.92);
    cursor: pointer;
    opacity: 0;
    animation: pop 0.35s cubic-bezier(0.3, 1.4, 0.5, 1) forwards;
    transition: scale 0.15s, background 0.15s;
  }
  .dot.last {
    background: #ffd6c2;
    box-shadow: 0 0 8px rgba(255, 214, 194, 0.8);
  }
  .dot:hover,
  .dot:focus-visible {
    z-index: 2;
    background: #fff;
    scale: 1.35;
    outline: none;
  }
  /* The hovered session's time and title, just above the strip (counter-scaled against the cell's hover zoom). */
  .tip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    translate: -50% 0;
    scale: 0.74;
    transform-origin: bottom center;
    font-family: var(--b-code);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    color: #fff;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
  }
  .tip.end {
    left: auto;
    right: 0;
    translate: 0 0;
    transform-origin: bottom right;
  }
  .tip.start {
    left: 0;
    translate: 0 0;
    transform-origin: bottom left;
  }
  .dot:hover .tip,
  .dot:focus-visible .tip {
    opacity: 1;
  }
  /* Axis labels at a fixed 10px, whatever the card's width. */
  .ticks {
    position: relative;
    height: 16px;
    margin-top: 8px;
    font-family: var(--b-code);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
  }
  .tick {
    position: absolute;
    top: 0;
    translate: -50% 0;
    white-space: nowrap;
  }
  .tick.start {
    translate: 0 0;
  }
  .tick.end {
    translate: -100% 0;
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
  /* brief.css turns every animation off here; the dots must not stay at their hidden start frame. */
  @media (prefers-reduced-motion: reduce) {
    .dot {
      opacity: 1;
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
    background: rgba(255, 255, 255, 0.22);
  }
  .track i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: #fff;
    box-shadow: 0 0 12px rgba(255, 255, 255, 0.6);
    transition: width 1.1s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .meter b {
    font-family: var(--b-mono);
    font-size: 13px;
    font-weight: 500;
    color: rgb(var(--b-ink) / 0.8);
  }
  /* The estimate sits after the count in the same mono, dimmer, with its own chip. */
  .eta {
    flex: none;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    padding: 3px 8px;
    border-radius: 999px;
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(255, 255, 255, 0.12);
    white-space: nowrap;
  }
</style>
