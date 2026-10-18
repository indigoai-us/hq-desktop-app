<script lang="ts">
  /**
   * Rise into the sky (round 11b) over the shared BriefDawn horizon.
   * Icons are clipped at the waterline. Nothing is drawn underwater, and
   * there is no reflection. Pass `elapsed` to freeze a frame; otherwise the
   * rise runs from mount. `meter` is the loading path's progressbar.
   *
   * The count and the finding card sit together just below the horizon.
   * The count is one line. The card is the finding, not a second count.
   */
  import { onDestroy, type Snippet } from "svelte";
  import { BRAND_ICONS, type BrandMark } from "../common/button/rail-icons.js";
  import BriefDawn from "./BriefDawn.svelte";
  import {
    riseDawnProgress,
    riseFrame,
    riseHaloCells,
    riseRippleCells,
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
  const halo = $derived(riseHaloCells(resolvedTheme));
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
    <div class="above">
      {#each frame.icons as icon (icon.id)}
        {#if icon.visible}
          {@const source = sources.find((item) => item.id === icon.id)}
          {@const mark = source ? markFor(source) : null}
          <div
            class="icon"
            data-testid={`brief-rise-icon-${icon.id}`}
            data-whole={icon.whole ? "true" : "false"}
            style:--lane="{icon.lane}px"
            style:--y="{icon.centerY}px"
            style:--op={icon.opacity}
          >
            <span class="halo" aria-hidden="true">
              {#each halo as cell (`${cell.x},${cell.y}`)}
                <i style="left:{cell.x}px;top:{cell.y}px;background:{cell.color}"></i>
              {/each}
            </span>
            {#if mark}
              <svg class="mark" class:clay={mark.fill === "clay"} viewBox={mark.viewBox} width="60" height="60">
                <path fill-rule="evenodd" d={mark.d} />
              </svg>
            {:else}
              <span class="initials">{source ? initials(source) : ""}</span>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
    <div class="sea">
      {#each frame.icons as icon (icon.id)}
        {#if icon.ripple}
          <div class="ripple" style:--lane="{icon.lane}px" data-testid={`brief-rise-ripple-${icon.id}`}>
            {#each riseRippleCells(icon.rippleAge, resolvedTheme) as cell (`${icon.id}:${cell.x},${cell.y}`)}
              <i style="left:{cell.x}px;top:{cell.y}px;background:{cell.color}"></i>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
    <div class="readout">
      {#if frame.countText}
        <p class="count" data-testid="brief-rise-count">{frame.countText}</p>
      {/if}
      {#if companies}
        <p class="companies" data-testid="brief-rise-companies">{frame.companiesLine}</p>
      {/if}
      {#if frame.cards.length}
        <ul class="cards">
          {#each frame.cards as card (card.id)}
            {#if card.failed}
              <li class="failed" data-testid={`brief-rise-card-${card.id}`}>{card.text}</li>
            {:else}
              <li class="card" data-testid={`brief-rise-card-${card.id}`}>
                <div class="head"><span>{card.label}</span><span>Found</span></div>
                <p class="quote">{card.text}</p>
                {#if card.detail}<p class="detail">{card.detail}</p>{/if}
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </div>
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
  /* The waterline is the bottom of this box. Overflow clips the icon and its halo. */
  .above {
    position: absolute;
    inset: 0 0 50% 0;
    overflow: hidden;
    z-index: 2;
  }
  .icon {
    position: absolute;
    left: calc(50% + var(--lane));
    top: calc(100% + var(--y));
    width: 60px;
    height: 60px;
    transform: translate(-50%, -50%);
    opacity: var(--op);
  }
  .halo {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
  }
  .halo i,
  .ripple i {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 1px;
  }
  .mark,
  .initials {
    position: relative;
    z-index: 1;
  }
  .mark {
    display: block;
    fill: #1a1a1a;
  }
  .mark.clay {
    fill: #c96442;
  }
  .initials {
    display: grid;
    place-items: center;
    width: 60px;
    height: 60px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: #1a1a1a;
  }
  .sea {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 48px;
    z-index: 2;
    pointer-events: none;
  }
  .ripple {
    position: absolute;
    left: calc(50% + var(--lane));
    top: 0;
    width: 0;
    height: 0;
  }
  .readout {
    position: absolute;
    left: 28px;
    top: calc(50% + 18px);
    width: min(420px, calc(50% - 80px));
    z-index: 3;
    color: rgba(255, 236, 220, 0.94);
  }
  .stage[data-theme="light"] .readout {
    color: #2a1c16;
  }
  .count,
  .companies {
    margin: 0;
  }
  .count {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }
  .companies {
    margin-top: 4px;
    font-size: 13px;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
  }
  .card {
    padding: 12px 14px;
    border-radius: 16px;
    background: rgba(22, 16, 24, 0.72);
  }
  .stage[data-theme="light"] .card {
    background: rgba(255, 250, 243, 0.94);
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.72;
  }
  .quote,
  .detail,
  .failed {
    margin: 0;
  }
  .quote {
    margin-top: 6px;
    font-size: 15px;
    line-height: 1.35;
  }
  .detail {
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.72;
  }
  .failed {
    font-size: 13px;
    line-height: 1.35;
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
</style>
