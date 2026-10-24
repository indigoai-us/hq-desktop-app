<script lang="ts">
  /**
   * The brief header's run row: the history navigator over index.jsonl, the
   * "viewing an older brief" note and missing files. Create brief / Refresh
   * sits on the title row (BriefCreateButton). Briefs are made on demand, so every
   * label is the time a brief was created, never "today".
   *
   * Only the squares, kept quiet: the sunrise strip's cells, one per recent
   * brief, oldest on the left, the shown one lit. Hover names the brief;
   * click or the arrow keys step through them.
   */
  import Tooltip from "../common/Tooltip.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import { missingNote, relativeRunLabel, stepRun, type BriefIndexEntry } from "./brief-runs.js";

  interface Props {
    entries: readonly BriefIndexEntry[];
    selectedRunId: string | null;
    latestRunId: string | null;
    now: Date;
    onselect: (runId: string) => void;
    /** Files the shown run is missing, by name. */
    missing?: readonly string[];
    /**
     * No brief yet today: the page's default view is Create brief, and any
     * brief in the strip is an earlier day's. Set, the way back from one of
     * them is "Back to today" (this), not "Back to latest".
     */
    onback?: (() => void) | null;
  }
  let { entries, selectedRunId, latestRunId, now, onselect, missing = [], onback = null }: Props = $props();

  /** Squares in the strip; older briefs stay one step or one pick away. */
  const STRIP = 14;

  const step = $derived(stepRun(entries, selectedRunId));
  const selected = $derived(entries.find((e) => e.runId === selectedRunId) ?? null);
  const viewingOld = $derived(selectedRunId != null && (onback ? true : latestRunId != null && selectedRunId !== latestRunId));
  /** With nothing selected (today's Create brief view), the strip starts from the newest brief. */
  const anchor = $derived(step.index >= 0 ? step.index : 0);
  /** Entries are newest first; the strip reads left to right in time. */
  const strip = $derived.by(() => {
    // The window always holds the shown brief, however far back it is.
    const from = Math.max(0, anchor - STRIP + 1);
    return entries.slice(from, from + STRIP).reverse();
  });
  /** One earlier brief is still worth a square when today has none yet: it is the only way back to it. */
  const showStrip = $derived(strip.length > 1 || (onback != null && strip.length > 0));

  function countsLabel(e: BriefIndexEntry): string {
    const parts = [
      `${e.counts.decisions} decision${e.counts.decisions === 1 ? "" : "s"}`,
      `${e.counts.shipped} shipped`,
      `${e.counts.incidents} incident${e.counts.incidents === 1 ? "" : "s"}`,
    ];
    return parts.join(" · ");
  }
  function optionLabel(e: BriefIndexEntry): string {
    const state = e.state === "failed" ? " · failed" : e.state === "running" ? " · in progress" : "";
    const catchUp = e.catchUp ? " · catch-up" : "";
    return `${relativeRunLabel(e.createdAt, now)}${catchUp}${state} · ${e.headline || "No headline"}`;
  }
  function onkey(ev: KeyboardEvent): void {
    // From today's Create brief view (nothing selected), Left opens the newest earlier brief.
    const to = ev.key === "ArrowLeft" ? (step.index < 0 ? (entries[0] ?? null) : step.older) : ev.key === "ArrowRight" ? step.newer : null;
    if (ev.key === "ArrowRight" && !to && onback && selectedRunId != null) {
      ev.preventDefault();
      onback();
      return;
    }
    if (!to) return;
    ev.preventDefault();
    const strip = ev.currentTarget as HTMLElement;
    onselect(to.runId);
    queueMicrotask(() => strip.querySelector<HTMLElement>(`[data-run="${to.runId}"]`)?.focus());
  }
</script>

<div class="runbar" data-testid="brief-runbar">
  {#if showStrip}
    <!-- Arrow keys step older / newer from any square. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="strip" role="group" aria-label="Brief history" data-testid="brief-run-strip" onkeydown={onkey}>
      {#each strip as e (e.runId)}
        <Tooltip label={`${optionLabel(e)} · ${countsLabel(e)}`} align="start">
          {#snippet trigger(describedBy: string)}
            <button
              type="button"
              class="cell"
              class:on={e.runId === selectedRunId}
              class:failed={e.state === "failed"}
              class:running={e.state === "running"}
              aria-label={optionLabel(e)}
              aria-current={e.runId === selectedRunId ? "true" : undefined}
              aria-describedby={describedBy || undefined}
              onclick={() => e.runId !== selectedRunId && onselect(e.runId)}
              data-testid="brief-run-cell"
              data-run={e.runId}
            ><span class="px"></span></button>
          {/snippet}
        </Tooltip>
      {/each}
    </div>
  {/if}

  {#if viewingOld && selected}
    <span class="viewing" data-testid="brief-viewing">
      <span class="sr">Viewing an older brief</span>
      {#if onback}
        <RailButton icon="arrow-right" variant="ghost" onclick={() => onback?.()} data-testid="brief-today">Back to today</RailButton>
      {:else}
        <RailButton icon="arrow-right" variant="ghost" onclick={() => latestRunId && onselect(latestRunId)} data-testid="brief-latest">Back to latest</RailButton>
      {/if}
    </span>
  {/if}

  {#if missing.length}
    <span class="miss" data-testid="brief-missing">{missingNote(missing)}</span>
  {/if}
</div>

<style>
  .runbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    font-size: 12px;
    color: var(--b-t3);
  }
  /* One square per brief, as the sunrise strip draws its cells, kept faint: only the shown one reads. */
  .strip {
    display: inline-flex;
    align-items: center;
    margin-left: -2px;
  }
  .cell {
    appearance: none;
    display: grid;
    place-items: center;
    width: 11px;
    height: 16px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .px {
    width: 7px;
    height: 7px;
    border-radius: 1.5px;
    background: rgb(var(--b-ink) / 0.12);
    transition:
      transform 0.16s ease,
      background 0.16s;
  }
  .cell:hover .px,
  .cell:focus-visible .px {
    transform: scale(1.35);
    background: rgb(var(--b-ink) / 0.32);
  }
  .cell.on .px {
    background: rgb(var(--b-ink) / 0.55);
  }
  .cell.running:not(.on) .px {
    background: rgb(var(--b-ink) / 0.22);
  }
  .cell.failed:not(.on) .px {
    background: color-mix(in srgb, var(--b-hot) 40%, transparent);
  }
  .cell:focus-visible {
    outline: none;
  }
  .viewing {
    display: inline-flex;
    align-items: center;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .miss {
    color: var(--b-warn);
  }
  @media (prefers-reduced-motion: reduce) {
    .px {
      transition: none;
    }
    .cell:hover .px,
    .cell:focus-visible .px {
      transform: none;
    }
  }
</style>
