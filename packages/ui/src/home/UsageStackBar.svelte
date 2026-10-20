<script lang="ts">
  /**
   * The usage bar shared by the Core menu meter and Settings > Usage (owner
   * direction, Corey, 2026-10-19: "Stacked bar rows"). Each usage group is a
   * coloured part, so the bar shows both how much is used and where it went,
   * against a scale (the $10 included, or the trial cap). Every effect states
   * something:
   * - Colour: the groups when calm; amber from 80% of a limit and red at the
   *   limit or when sync is paused (`tone`), so the bar alone says "careful".
   * - Marker: a labelled tick for the spend limit or trial cap. A limit past
   *   the end of the scale is named at the bar's end with an arrow.
   * - Included tick: where the $10 included ends once usage has passed it.
   * - Fill: grows from the old total to the new one when a total changes, and
   *   from empty when `grow="mount"` (a line that just opened). Nothing moves
   *   on a first paint otherwise, and nothing moves under reduced motion.
   */
  import { onMount } from "svelte";
  import { segmentColor, type StackMarker, type StackSegment, type StackTone } from "./usage-stack.js";

  let {
    segments,
    scaleCents,
    tone = "ok",
    marker = null,
    includedCents = null,
    size = "lg",
    grow = "change",
    label = "",
    ...rest
  }: {
    segments: readonly StackSegment[];
    /** The value at the right end of the bar. */
    scaleCents: number;
    tone?: StackTone;
    marker?: StackMarker | null;
    /** Draws an "Included" tick when usage has passed it (scale above it). */
    includedCents?: number | null;
    size?: "lg" | "md" | "sm";
    /** "mount": grow from empty when shown; "change": only when the total changes. */
    grow?: "mount" | "change";
    /** Spoken summary; the default lists the parts. */
    label?: string;
    [key: string]: unknown;
  } = $props();

  const scale = $derived(Math.max(1, scaleCents));
  const total = $derived(segments.reduce((sum, s) => sum + Math.max(0, s.cents), 0));
  const fillPct = $derived(Math.min(100, (total / scale) * 100));
  const parts = $derived(
    segments
      .filter((s) => s.cents > 0)
      .map((s) => ({ ...s, pct: Math.min(100, (Math.max(0, s.cents) / scale) * 100) })),
  );
  const markerPct = $derived(marker ? (marker.cents / scale) * 100 : null);
  const includedPct = $derived(
    includedCents !== null && includedCents > 0 && includedCents < scale ? (includedCents / scale) * 100 : null,
  );
  const spoken = $derived(
    label ||
      parts.map((p) => `${p.label} ${(p.cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`).join(", "),
  );

  // What is drawn now. Starts at the real value (no motion on a first paint)
  // unless the bar grows on mount; later changes animate from the old value.
  let reveal = $state(0);
  let mounted = $state(false);
  onMount(() => {
    if (grow === "mount") {
      const id = requestAnimationFrame(() => requestAnimationFrame(() => (mounted = true)));
      return () => cancelAnimationFrame(id);
    }
    mounted = true;
  });
  $effect(() => {
    const target = fillPct;
    if (!mounted) {
      if (grow === "change") reveal = target;
      return;
    }
    reveal = target;
  });
</script>

<span
  class="stack"
  data-size={size}
  data-tone={tone}
  role="img"
  aria-label={spoken}
  {...rest}
>
  <span class="track">
    <span class="fill" style={`--reveal:${reveal}%;`} data-reveal={Math.round(fillPct)}>
      {#each parts as part (part.id)}
        <span class="seg" data-segment={part.id} style={`width:${part.pct}%;--seg:${segmentColor(part.id)};`}></span>
      {/each}
    </span>
    {#if includedPct !== null}
      <span class="tick included" style={`left:${includedPct}%`} title="Included usage ends here"></span>
    {/if}
    {#if marker && markerPct !== null && markerPct <= 100}
      <span class="tick marker" style={`left:${Math.max(0, markerPct)}%`} data-testid="usage-bar-marker"></span>
    {/if}
  </span>
  {#if marker && size === "lg"}
    <span
      class="marker-label"
      class:beyond={markerPct !== null && markerPct > 100}
      style={markerPct !== null && markerPct <= 100 ? `left:${Math.max(0, markerPct)}%` : undefined}
      data-testid="usage-bar-marker-label"
    >{marker.label}{markerPct !== null && markerPct > 100 ? " ›" : ""}</span>
  {/if}
</span>

<style>
  .stack {
    position: relative;
    display: block;
    width: 100%;
  }

  .track {
    position: relative;
    display: block;
    height: 10px;
    border-radius: 999px;
    background: var(--v4-control-faint, var(--line2, rgba(127, 127, 127, 0.18)));
  }

  .stack[data-size="md"] .track {
    height: 6px;
  }

  .stack[data-size="sm"] .track {
    height: 4px;
  }

  /* The parts sit at their final widths; the clip reveals them up to the
     total, so a change grows from the old total to the new one. */
  .fill {
    display: flex;
    height: 100%;
    overflow: hidden;
    border-radius: inherit;
    clip-path: inset(0 calc(100% - var(--reveal, 0%)) 0 0 round 999px);
    transition: clip-path 520ms cubic-bezier(0.22, 0.8, 0.24, 1);
  }

  .seg {
    flex: none;
    height: 100%;
    background: var(--seg);
    transition: background-color 240ms ease;
  }

  /* A hairline between parts keeps the split readable at any tone. */
  .seg + .seg {
    box-shadow: inset 2px 0 0 var(--v4-popover-strong, var(--elevated, rgba(0, 0, 0, 0.35)));
  }

  /* Near a limit every part turns amber, at it (or paused) red; the parts
     keep stepped strengths so the split still reads. */
  .stack[data-tone="near"] .seg {
    background: var(--warn, #f0a800);
  }

  .stack[data-tone="at"] .seg {
    background: var(--v4-error, var(--red, #dc2626));
  }

  .stack[data-tone="near"] .seg:nth-child(2),
  .stack[data-tone="at"] .seg:nth-child(2) {
    opacity: 0.78;
  }

  .stack[data-tone="near"] .seg:nth-child(3),
  .stack[data-tone="at"] .seg:nth-child(3) {
    opacity: 0.56;
  }

  .tick {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    margin-left: -1px;
    border-radius: 1px;
  }

  .tick.marker {
    background: var(--t1, currentColor);
  }

  .stack[data-tone="near"] .tick.marker {
    background: var(--warn-ink, var(--warn, #b45309));
  }

  .stack[data-tone="at"] .tick.marker {
    background: var(--v4-error, var(--red, #dc2626));
  }

  .tick.included {
    top: 0;
    bottom: 0;
    width: 1px;
    margin-left: 0;
    background: var(--t3, rgba(127, 127, 127, 0.6));
  }

  .marker-label {
    position: absolute;
    top: calc(100% + 3px);
    transform: translateX(-100%);
    color: var(--t3, var(--t2));
    font-size: 10px;
    line-height: 1.2;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .marker-label.beyond {
    right: 0;
    transform: none;
  }

  .stack:has(.marker-label) {
    padding-bottom: 14px;
  }

  @media (prefers-reduced-motion: reduce) {
    .fill,
    .seg {
      transition: none;
    }
  }
</style>
