<script lang="ts">
  /**
   * The usage bar shared by the Core menu meter and Settings > Usage (owner
   * direction, Corey, 2026-10-19: "Stacked bar rows"). Each usage group is a
   * coloured part, so the bar shows both how much is used and where it went,
   * against a scale (the $10 included, or the trial cap). Every effect states
   * something:
   * - Colour: each part is always its group's colour, matching the legend
   *   dots and the group bars. Limit state is a thin outline (amber from 80%
   *   of a limit, red at it or when sync is paused) and the marker's colour.
   * - Ticks: the limit (when it falls on the scale) and, once usage has
   *   passed it, the end of the included usage. Each is labelled at its tick;
   *   nothing is labelled off the bar.
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
  /** A limit is drawn only where it falls on the scale. */
  const markerPct = $derived(marker && marker.cents >= 0 && marker.cents <= scale ? (marker.cents / scale) * 100 : null);
  const includedPct = $derived(
    includedCents !== null && includedCents > 0 && includedCents < scale ? (includedCents / scale) * 100 : null,
  );
  /** Labels under the bar, anchored so they never run past either end. */
  const labels = $derived(
    size !== "lg"
      ? []
      : [
          ...(markerPct !== null && marker ? [{ id: "marker", pct: markerPct, text: marker.label }] : []),
          // Two labels this close would collide; the limit wins.
          ...(includedPct !== null && includedCents !== null && (markerPct === null || Math.abs(markerPct - includedPct) > 22)
            ? [{ id: "included", pct: includedPct, text: `Included ${(includedCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}` }]
            : []),
        ].map((l) => ({ ...l, anchor: l.pct > 78 ? "end" : l.pct < 22 ? "start" : "middle" })),
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
    {#if markerPct !== null}
      <span class="tick marker" style={`left:${markerPct}%`} data-testid="usage-bar-marker"></span>
    {/if}
  </span>
  {#if labels.length}
    <span class="labels">
      {#each labels as l (l.id)}
        <span class="tick-label" data-anchor={l.anchor} style={`left:${l.pct}%`} data-testid={`usage-bar-${l.id}-label`}>{l.text}</span>
      {/each}
    </span>
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
  }

  /* A hairline between parts keeps the split readable at any tone. */
  .seg + .seg {
    box-shadow: inset 2px 0 0 var(--v4-popover-strong, var(--elevated, rgba(0, 0, 0, 0.35)));
  }

  /* Limit state never re-tints the parts (they stay their group colour);
     a thin outline says it: amber near a limit, red at it or paused. */
  .stack[data-tone="near"] .track {
    box-shadow: 0 0 0 1.5px var(--warn, #f0a800);
  }

  .stack[data-tone="at"] .track {
    box-shadow: 0 0 0 1.5px var(--v4-error, var(--red, #dc2626));
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

  .labels {
    position: relative;
    display: block;
    height: 14px;
    margin-top: 4px;
  }

  .tick-label {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    color: var(--t2);
    font-size: 10.5px;
    line-height: 14px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .tick-label[data-anchor="end"] {
    transform: translateX(-100%);
  }

  .tick-label[data-anchor="start"] {
    transform: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
  }
</style>
