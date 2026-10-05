<script lang="ts">
  /**
   * Atlas time scrubber (US-014): play, 30-day histogram with a playhead,
   * Born/Touched toggle, and date readout. The parent owns the index and mode;
   * the map fades objects by opacity only while scrubbing or playing.
   */
  import { onDestroy } from "svelte";
  import {
    ATLAS_TIMELINE_DAYS,
    atlasHistogramHeights,
    atlasHotDays,
    atlasScrubLabel,
    type AtlasTimeMode,
  } from "./atlas-timeline.js";

  interface Props {
    counts: readonly number[];
    mode: AtlasTimeMode;
    /** Scrubbed day, or null at the live edge. */
    index: number | null;
    nowMs: number;
    disabled?: boolean;
    onmode: (mode: AtlasTimeMode) => void;
    onindex: (index: number | null) => void;
  }

  let { counts, mode, index, nowMs, disabled = false, onmode, onindex }: Props = $props();

  /** Milliseconds per day of playback; 30 days play in about three seconds. */
  const STEP_MS = 100;
  const last = ATLAS_TIMELINE_DAYS - 1;

  const heights = $derived(atlasHistogramHeights(counts));
  const hot = $derived(atlasHotDays(counts));
  const at = $derived(index ?? last);
  const label = $derived(atlasScrubLabel(index, nowMs));

  let playing = $state(false);
  let raf = 0;
  let histEl = $state<HTMLDivElement | null>(null);
  let dragging = false;

  function stop(): void {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function play(): void {
    if (playing) {
      stop();
      return;
    }
    playing = true;
    const start = performance.now();
    const from = index == null || index >= last ? 0 : index;
    onindex(from);
    const tickFrame = (t: number) => {
      if (!playing) return;
      const next = from + Math.floor((t - start) / STEP_MS);
      if (next >= last) {
        onindex(null);
        stop();
        return;
      }
      if (next !== index) onindex(next);
      raf = requestAnimationFrame(tickFrame);
    };
    raf = requestAnimationFrame(tickFrame);
  }

  function indexAt(clientX: number): number {
    const box = histEl?.getBoundingClientRect();
    if (!box || box.width <= 0) return last;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Math.min(last, Math.floor(f * ATLAS_TIMELINE_DAYS));
  }

  function seek(clientX: number): void {
    const i = indexAt(clientX);
    onindex(i >= last ? null : i);
  }

  function onpointerdown(event: PointerEvent): void {
    if (disabled || event.button !== 0) return;
    stop();
    dragging = true;
    histEl?.setPointerCapture?.(event.pointerId);
    seek(event.clientX);
  }

  function onpointermove(event: PointerEvent): void {
    if (dragging) seek(event.clientX);
  }

  function onpointerup(event: PointerEvent): void {
    dragging = false;
    histEl?.releasePointerCapture?.(event.pointerId);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (disabled) return;
    if (event.key === "ArrowLeft") {
      stop();
      onindex(Math.max(0, at - 1));
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      stop();
      onindex(at + 1 >= last ? null : at + 1);
      event.preventDefault();
    } else if (event.key === "End") {
      stop();
      onindex(null);
      event.preventDefault();
    }
  }

  onDestroy(stop);
</script>

<div class="scrub" data-testid="atlas-scrubber" data-playing={playing ? "true" : undefined}>
  <button
    type="button"
    class="play"
    data-testid="atlas-scrub-play"
    aria-label={playing ? "Pause" : "Play 30 days"}
    {disabled}
    onclick={play}
  >
    {#if playing}
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M5 3.5v7M9 3.5v7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
    {:else}
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M4.5 3.2v7.6L10.8 7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" /></svg>
    {/if}
  </button>
  <div
    class="hist"
    bind:this={histEl}
    data-testid="atlas-scrub-hist"
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label="Day"
    aria-valuemin={0}
    aria-valuemax={last}
    aria-valuenow={at}
    aria-valuetext={label}
    aria-disabled={disabled}
    onpointerdown={onpointerdown}
    onpointermove={onpointermove}
    onpointerup={onpointerup}
    onpointercancel={onpointerup}
    {onkeydown}
  >
    {#each heights as h, i (i)}
      <i class:hot={hot[i]} class:past={i > at} style:height={`${h}%`}></i>
    {/each}
    <span
      class="ph"
      data-testid="atlas-scrub-playhead"
      style:left={`${((at + 1) / ATLAS_TIMELINE_DAYS) * 100}%`}
    ></span>
  </div>
  <div class="tog">
    <button
      type="button"
      class="tab"
      data-testid="atlas-scrub-born"
      aria-pressed={mode === "born"}
      onclick={() => onmode("born")}
    >Born</button>
    <button
      type="button"
      class="tab"
      data-testid="atlas-scrub-touched"
      aria-pressed={mode === "touched"}
      onclick={() => onmode("touched")}
    >Touched</button>
    <span class="now" data-testid="atlas-scrub-date">{label}</span>
  </div>
</div>

<style>
  .scrub {
    user-select: none;
    -webkit-user-select: none;
    display: grid;
    grid-template-columns: 44px 1fr 170px;
    align-items: center;
    gap: 12px;
    height: 48px;
    padding: 0 12px 0 8px;
    margin-bottom: 6px;
    border-top: 1px solid var(--v4-rowline);
    flex: none;
  }
  .play {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--t2, var(--v4-text-2));
    cursor: pointer;
  }
  .play:hover:not(:disabled) {
    background: var(--hover, var(--v4-hover));
    color: var(--t1, var(--v4-text-1));
  }
  .play:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hist {
    position: relative;
    height: 30px;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    cursor: pointer;
    touch-action: none;
    outline: none;
  }
  .hist[aria-disabled="true"] {
    cursor: default;
  }
  .hist i {
    flex: 1;
    background: var(--v4-control-faint);
    border-radius: 1px 1px 0 0;
    transition: opacity 120ms ease;
  }
  .hist i.hot {
    background: var(--v4-text-3);
  }
  .hist i.past {
    opacity: 0.4;
  }
  .ph {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 1.5px;
    margin-left: -1.5px;
    background: var(--v4-text-1);
    pointer-events: none;
  }
  .ph::after {
    content: "";
    position: absolute;
    top: -3px;
    left: -4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--v4-text-1);
  }
  .tog {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
    font-size: 13px;
  }
  .tab {
    padding: 4px 8px;
    border: 0;
    border-radius: 6px;
    font-size: 13px;
    background: none;
    color: var(--v4-text-2);
    font: inherit;
    cursor: pointer;
  }
  .tab[aria-pressed="true"] {
    background: var(--sel, var(--v4-active-row));
    color: var(--t1, var(--v4-text-1));
  }
  .now {
    min-width: 42px;
    text-align: right;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--t3, var(--v4-text-3));
  }
</style>
