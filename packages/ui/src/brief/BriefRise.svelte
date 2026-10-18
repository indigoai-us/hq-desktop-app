<script lang="ts">
  /**
   * Rise into the sky (round 11b) over the shared BriefDawn horizon.
   * Icons are clipped at the waterline. Nothing is drawn underwater, and
   * there is no reflection. Pass `elapsed` to freeze a frame; otherwise the
   * rise runs from mount. `meter` is the loading path's progressbar.
   */
  import { onDestroy, type Snippet } from "svelte";
  import { BRAND_ICONS, type BrandMark } from "../common/button/rail-icons.js";
  import BriefDawn from "./BriefDawn.svelte";
  import {
    RISE_ICON,
    riseDawnProgress,
    riseFrame,
    type RiseCompany,
    type RiseSource,
  } from "./brief-rise.js";

  interface Props {
    sources: readonly RiseSource[];
    companies?: readonly RiseCompany[];
    /** Frozen seconds. Absent: animate from mount. */
    elapsed?: number | null;
    /** Seconds when the brief may fade in. Null keeps the sunrise, including past two minutes. */
    readyAt?: number | null;
    theme?: "dark" | "light" | null;
    reducedMotion?: boolean | null;
    /** Accessible progress for the loading path only. Setup and blocked leave this off. */
    meter?: { now: number | null; label: string } | null;
    briefOpacity?: number;
    children?: Snippet;
  }
  let {
    sources,
    companies,
    elapsed = null,
    readyAt = null,
    theme = null,
    reducedMotion = null,
    meter = null,
    briefOpacity = $bindable(0),
    children,
  }: Props = $props();

  let live = $state(0);
  let reduced = $state(false);
  let resolvedTheme = $state<"dark" | "light">("dark");
  let raf = 0;

  function readTheme(): "dark" | "light" {
    if (theme === "light" || theme === "dark") return theme;
    const forced = globalThis.document?.documentElement?.dataset?.forceTheme;
    if (forced === "light" || forced === "dark") return forced;
    if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches) return "light";
    return "dark";
  }

  $effect(() => {
    resolvedTheme = readTheme();
    reduced = reducedMotion == null
      ? typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
      : reducedMotion;
  });

  $effect(() => {
    if (elapsed != null) {
      cancelAnimationFrame(raf);
      return;
    }
    const started = performance.now();
    const tick = (now: number) => {
      live = (now - started) / 1000;
      raf = requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  onDestroy(() => cancelAnimationFrame(raf));

  const t = $derived(elapsed != null && Number.isFinite(elapsed) ? elapsed : live);
  const frame = $derived(
    riseFrame(t, sources, {
      reducedMotion: reduced,
      readyAt,
      ...(companies ? { companies } : {}),
    }),
  );
  const dawn = $derived(riseDawnProgress(t, readyAt));
  $effect(() => {
    briefOpacity = frame.briefOpacity;
  });

  function markFor(source: RiseSource): BrandMark | null {
    if (source.id === "claude" || source.icon === "claude") return BRAND_ICONS["claude-code"];
    if (source.id === "codex" || source.icon === "codex") return BRAND_ICONS.codex;
    if (source.id === "grok" || source.icon === "grok") return BRAND_ICONS.grok;
    return null;
  }

  function initials(source: RiseSource): string {
    const word = source.label.trim();
    if (!word) return "";
    return word.slice(0, 2);
  }

  const half = RISE_ICON / 2;
</script>

<div
  class="stage"
  data-testid="brief-rise"
  data-theme={resolvedTheme}
  data-elapsed={frame.elapsed.toFixed(3)}
  data-brief-opacity={frame.briefOpacity.toFixed(2)}
>
  <BriefDawn progress={dawn} phase={frame.briefOpacity >= 1 ? "ready" : "running"} size="page" theme={resolvedTheme} />
  <div class="overlay" aria-hidden={meter ? undefined : "true"}>
    {#each frame.icons as icon (icon.id)}
      {#if icon.visible}
        {@const source = sources.find((item) => item.id === icon.id)}
        {@const mark = source ? markFor(source) : null}
        <div
          class="icon"
          data-testid={`brief-rise-icon-${icon.id}`}
          style:--lane="{icon.lane}px"
          style:--y="{icon.centerY}px"
          style:--op={icon.opacity}
          style:--clip="{Math.max(0, icon.centerY + half)}px"
        >
          <span class="halo"></span>
          {#if mark}
            <svg class="mark" class:clay={mark.fill === "clay"} viewBox={mark.viewBox} width="60" height="60">
              <path fill-rule="evenodd" d={mark.d} />
            </svg>
          {:else}
            <span class="initials">{source ? initials(source) : ""}</span>
          {/if}
        </div>
        {#if icon.ripple}
          <div class="ripple" style:--lane="{icon.lane}px" data-testid={`brief-rise-ripple-${icon.id}`}></div>
        {/if}
      {/if}
    {/each}
    {#if frame.countText}
      <p class="count" data-testid="brief-rise-count">{frame.countText}</p>
    {/if}
    {#if companies}
      <p class="companies" data-testid="brief-rise-companies">{frame.companiesLine}</p>
    {/if}
    {#if frame.cards.length}
      <ul class="cards">
        {#each frame.cards as card (card.id)}
          <li class:failed={card.failed} data-testid={`brief-rise-card-${card.id}`}>{card.text}</li>
        {/each}
      </ul>
    {/if}
    {#if meter}
      <div
        class="sr"
        role="progressbar"
        aria-label={meter.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={meter.now ?? undefined}
      >{meter.label}</div>
    {/if}
    {#if children}
      <div class="invite">{@render children()}</div>
    {/if}
  </div>
</div>

<style>
  .stage {
    position: relative;
    height: 100%;
    min-height: 640px;
    overflow: hidden;
    background: #121216;
  }
  .stage[data-theme="light"] {
    background: #f4efe9;
  }
  .stage :global(.dawn.page) {
    --sky-h: 100%;
    height: 100%;
    min-height: 100%;
    border-radius: 0;
  }
  .stage :global(.dawn .sky) {
    height: 100%;
  }
  .stage :global(.dawn .copy) {
    display: none;
  }
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .icon {
    position: absolute;
    left: calc(50% + var(--lane));
    top: calc(50% + var(--y));
    width: 60px;
    height: 60px;
    transform: translate(-50%, -50%);
    opacity: var(--op);
    clip-path: inset(0 0 var(--clip) 0);
    display: grid;
    place-items: center;
  }
  .halo {
    position: absolute;
    inset: -18px;
    background-image: radial-gradient(circle, rgba(255, 184, 160, 0.72) 0 3px, transparent 3.5px);
    background-size: 8px 8px;
    background-position: center;
    mask-image: radial-gradient(circle, #000 20%, transparent 70%);
  }
  .mark {
    position: relative;
    fill: #1a1a1a;
  }
  .mark.clay {
    fill: #c96442;
  }
  .initials {
    position: relative;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: #1a1a1a;
  }
  .ripple {
    position: absolute;
    left: calc(50% + var(--lane));
    top: 50%;
    width: 96px;
    height: 16px;
    transform: translate(-50%, -50%);
    background-image: radial-gradient(circle, rgba(255, 190, 170, 0.9) 0 3px, transparent 3.5px);
    background-size: 8px 8px;
    animation: ripple 0.6s ease-out both;
    pointer-events: none;
  }
  @keyframes ripple {
    from { opacity: 0.9; transform: translate(-50%, -50%) scaleX(0.4); }
    to { opacity: 0; transform: translate(-50%, -50%) scaleX(1.35); }
  }
  .count,
  .companies,
  .cards {
    position: absolute;
    left: 28px;
    width: min(300px, calc(50% - 140px));
    margin: 0;
    color: rgba(255, 236, 220, 0.94);
  }
  .stage[data-theme="light"] .count,
  .stage[data-theme="light"] .companies,
  .stage[data-theme="light"] .cards {
    color: #3a2a22;
  }
  .count {
    top: calc(50% - 96px);
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }
  .companies {
    top: calc(50% - 68px);
    font-size: 13px;
  }
  .cards {
    top: 64px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0;
    list-style: none;
  }
  .cards li {
    padding: 8px 12px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.14);
    font-size: 13px;
    line-height: 1.35;
  }
  .cards li.failed {
    background: transparent;
    padding-left: 0;
  }
  .invite {
    position: absolute;
    left: 28px;
    bottom: 28px;
    width: min(420px, calc(50% - 120px));
    pointer-events: auto;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  @media (prefers-reduced-motion: reduce) {
    .ripple { animation: none; opacity: 0; }
  }
</style>
