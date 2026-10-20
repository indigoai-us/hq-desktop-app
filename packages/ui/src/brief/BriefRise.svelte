<script lang="ts">
  /**
   * Rise into the sky (round 11b) over the shared BriefDawn horizon.
   * Icons are clipped at the waterline. Nothing is drawn underwater, and
   * there is no reflection. Pass `elapsed` to freeze a frame; otherwise the
   * rise runs from mount. `meter` is the loading path's progressbar.
   *
   * Round 11b page: breadcrumb and date, the hero headline, an invite slot
   * over the sea (the welcome report places its connect strip there), then the
   * progress block under the sea with the count, the elapsed time, what is being
   * read, and the finding cards. The count is one line. A card is the finding,
   * not a second count.
   */
  import { onDestroy, type Snippet } from "svelte";
  import { BRAND_ICONS, type BrandMark } from "../common/button/rail-icons.js";
  import BriefDawn from "./BriefDawn.svelte";
  import { welcomeSunX } from "./brief-dawn.js";
  import {
    RISE_CRUMB,
    RISE_EYEBROW,
    RISE_HEADLINE,
    RISE_READING,
    RISE_SUB,
    riseDateLine,
    riseElapsedText,
    riseStepLine,
    riseDawnProgress,
    riseFrame,
    riseHaloCells,
    riseRippleCells,
    riseGeometry,
    RISE_MIN_HEIGHT,
    riseSeaBottom,
    type RiseCompany,
    type RiseLayout,
    type RiseIconFrame,
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
    /** The count line on screen ("168 sessions read · 6 repos"), null before the first source is read. The brief after the rise repeats it. */
    count?: string | null;
    /** The date in the page header. Absent: today. */
    now?: Date | null;
    /** Px kept clear under the progress block (the welcome report's open bar sits there). */
    foot?: number;
    /** Out: where the rise put its parts at the current size, so the report can place its connect strip in the invite slot. */
    geometry?: RiseLayout | null;
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
    count = $bindable(null),
    now = null,
    foot = 0,
    geometry = $bindable(null),
    children,
  }: Props = $props();

  let width = $state(0);
  let height = $state(0);
  let readoutHeight = $state(0);
  const sunX = $derived(welcomeSunX(width));
  // The stage follows its container: offsets scale with the height, the inset with the width.
  const geo = $derived(riseGeometry(width, height));
  const seaBottom = $derived(
    riseSeaBottom(geo.horizon, readoutHeight ? Math.max(height, RISE_MIN_HEIGHT) - geo.bottom - foot - readoutHeight : 0),
  );
  $effect(() => {
    geometry = { ...geo, readout: readoutHeight };
  });
  const dateLine = $derived(riseDateLine(now ?? new Date()));

  let live = $state(0);
  let reduced = $state(false);
  let resolvedTheme = $state<"dark" | "light">("dark");
  let raf = 0;

  function readTheme(): "dark" | "light" {
    if (theme === "light" || theme === "dark") return theme;
    const forced = globalThis.document?.documentElement?.dataset?.forceTheme;
    if (forced === "light" || forced === "dark") return forced;
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
  // Theme A: the sunrise stays dark in both app themes, so the sky, halo and ripples always draw dark.
  const halo = $derived(riseHaloCells("dark"));
  const stepLine = $derived(riseStepLine(t, sources));
  $effect(() => {
    briefOpacity = frame.briefOpacity;
  });
  $effect(() => {
    count = frame.countText || null;
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

{#snippet riseIcon(icon: RiseIconFrame)}
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
        <i style="left:{cell.x}px;top:{cell.y}px;background:{cell.color};opacity:{cell.alpha}"></i>
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
{/snippet}

<div
  class="stage"
  data-testid="brief-rise"
  data-theme={resolvedTheme}
  data-elapsed={frame.elapsed.toFixed(3)}
  data-brief-opacity={frame.briefOpacity.toFixed(2)}
  bind:clientWidth={width}
  bind:clientHeight={height}
  style:--sun-x="{sunX}px"
  style:--hz="{geo.horizon}px"
  style:--pad="{geo.pad}px"
  style:--s={geo.scale}
  style:--top="{geo.headerTop}px"
  style:--hero-top="{geo.heroTop}px"
  style:--headline="{geo.headline}px"
  style:--invite-top="{geo.inviteTop}px"
  style:--bottom="{geo.bottom + foot}px"
>
  <BriefDawn progress={dawn} phase={frame.briefOpacity >= 1 ? "ready" : "running"} size="page" theme="dark" reflection={false} layout="welcome" horizon={geo.horizon} {seaBottom} />
  <div class="overlay" aria-hidden={meter ? undefined : "true"}>
    <header class="top">
      <span class="crumb" data-testid="brief-rise-crumb">{RISE_CRUMB}</span>
      <span class="date" data-testid="brief-rise-date">{dateLine}</span>
    </header>
    <div class="hero" data-testid="brief-rise-hero">
      <p class="eyebrow">{RISE_EYEBROW}</p>
      <h2>{RISE_HEADLINE}</h2>
      <p class="sub">{RISE_SUB}</p>
    </div>
    <!-- Emerging icons are clipped at the waterline. Whole icons sit in the free
         sky layer, so the bottom row of the halo is never cut off. -->
    <div class="above">
      {#each frame.icons as icon (icon.id)}
        {#if icon.visible && !icon.whole}
          {@render riseIcon(icon)}
        {/if}
      {/each}
    </div>
    <div class="above free">
      {#each frame.icons as icon (icon.id)}
        {#if icon.visible && icon.whole}
          {@render riseIcon(icon)}
        {/if}
      {/each}
    </div>
    <div class="sea">
      {#each frame.icons as icon (icon.id)}
        {#if icon.ripple}
          <div class="ripple" style:--lane="{icon.lane}px" data-testid={`brief-rise-ripple-${icon.id}`}>
            {#each riseRippleCells(icon.rippleAge, "dark") as cell (`${icon.id}:${cell.x},${cell.y}`)}
              <i style="left:{cell.x}px;top:{cell.y}px;background:{cell.color};opacity:{cell.alpha}"></i>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
    <div class="readout" data-testid="brief-rise-progress" bind:clientHeight={readoutHeight}>
      <div class="status">
        {#if frame.countText}
          <p class="count" data-testid="brief-rise-count">{frame.countText}</p>
        {:else}
          <p class="count reading">{RISE_READING}</p>
        {/if}
        <p class="elapsed" data-testid="brief-rise-elapsed">{riseElapsedText(frame.elapsed)}</p>
      </div>
      <p class="step" data-testid="brief-rise-step">{stepLine}</p>
      {#if companies}
        <p class="companies" data-testid="brief-rise-companies">{frame.companiesLine}</p>
      {/if}
      {#if frame.cards.length}
        <ul class="cards">
          {#each frame.cards as card (card.id)}
            {@const source = sources.find((item) => item.id === card.id)}
            {@const mark = source ? markFor(source) : null}
            {#if card.failed}
              <li class="failed" data-testid={`brief-rise-card-${card.id}`}>{card.text}</li>
            {:else}
              <li class="card" data-testid={`brief-rise-card-${card.id}`}>
                <div class="head">
                  <span class="who">
                    {#if mark}
                      <span class="logo"><svg class:clay={mark.fill === "clay"} viewBox={mark.viewBox} width="16" height="16"><path fill-rule="evenodd" d={mark.d} /></svg></span>
                    {/if}
                    {card.label}
                  </span>
                  <span class="found">Found</span>
                </div>
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
  /* Offsets follow the round 11b page at 780 px and scale with the stage (riseGeometry): no fixed stage or offsets. */
  .stage {
    --serif: "Fraunces", "Iowan Old Style", Georgia, serif;
    --ink: rgba(255, 244, 236, 0.96);
    --ink-2: rgba(255, 236, 226, 0.78);
    position: relative;
    height: 100%;
    min-height: 560px;
    overflow: hidden;
    background: rgb(20, 18, 25);
    color: var(--ink);
  }
  .stage :global(.dawn.page) {
    --sky-h: 100%;
    position: absolute;
    inset: 0;
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
  .top {
    position: absolute;
    left: var(--pad);
    right: var(--pad);
    top: var(--top);
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--ink-2);
    z-index: 3;
  }
  .hero {
    position: absolute;
    left: var(--pad);
    right: var(--pad);
    top: var(--hero-top);
    max-width: 520px;
    z-index: 3;
  }
  .eyebrow {
    margin: 0;
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--ink-2);
  }
  h2 {
    margin: calc(16px * var(--s, 1)) 0 0;
    max-width: 440px;
    font-family: var(--serif);
    font-size: var(--headline, 56px);
    font-weight: 500;
    line-height: 1.07;
    letter-spacing: -0.035em;
    color: var(--ink);
  }
  .sub {
    margin: calc(22px * var(--s, 1)) 0 0;
    font-size: 15px;
    color: var(--ink-2);
  }
  /* The waterline is the bottom of this box. Overflow clips the icon and its halo. */
  .above {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: var(--hz);
    overflow: hidden;
    z-index: 2;
  }
  .above.free {
    overflow: visible;
  }
  .icon {
    position: absolute;
    left: calc(var(--sun-x) + var(--lane));
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
  .mark.clay,
  .logo svg.clay {
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
    top: var(--hz);
    height: 48px;
    z-index: 2;
    pointer-events: none;
  }
  .ripple {
    position: absolute;
    left: calc(var(--sun-x) + var(--lane));
    top: 0;
    width: 0;
    height: 0;
  }
  .readout {
    position: absolute;
    left: var(--pad);
    right: var(--pad);
    bottom: var(--bottom);
    z-index: 3;
  }
  .status {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 16px;
  }
  .count,
  .elapsed,
  .step,
  .companies {
    margin: 0;
  }
  .count {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .elapsed {
    font-size: 12px;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .step,
  .companies {
    margin-top: 12px;
    font-size: 13px;
    color: var(--ink-2);
  }
  .step::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 4px;
    margin: 0 9px 2px 1px;
    border-radius: 50%;
    background: currentColor;
  }
  .companies {
    margin-top: 4px;
    padding-left: 14px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 562px));
    gap: 16px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
  }
  .card,
  .failed {
    box-sizing: border-box;
    min-height: 100px;
    padding: 14px 16px;
    border-radius: 16px;
    background: rgba(48, 34, 56, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.16);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: #fffaf3;
  }
  .logo svg {
    fill: #1a1a1a;
  }
  .found {
    font-size: 11px;
    color: var(--ink-2);
  }
  .quote,
  .detail,
  .failed {
    margin: 0;
  }
  .quote {
    margin-top: 10px;
    font-size: 15px;
    line-height: 1.35;
  }
  .quote::before {
    content: "\201C";
  }
  .quote::after {
    content: "\201D";
  }
  .detail {
    margin-top: 4px;
    font-size: 11px;
    color: var(--ink-2);
  }
  .failed {
    font-size: 13px;
    line-height: 1.4;
    color: var(--ink-2);
  }
  /* The welcome report's connect strip sits here too, at the same offsets. */
  .invite {
    position: absolute;
    left: var(--pad);
    top: var(--invite-top);
    width: 485px;
    max-width: calc(100% - var(--pad) * 2);
    z-index: 4;
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
