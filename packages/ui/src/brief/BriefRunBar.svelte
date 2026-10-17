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
  }
  let { entries, selectedRunId, latestRunId, now, onselect, missing = [] }: Props = $props();

  /** Squares in the strip; older briefs stay one step or one pick away. */
  const STRIP = 14;

  const step = $derived(stepRun(entries, selectedRunId));
  const selected = $derived(entries.find((e) => e.runId === selectedRunId) ?? null);
  const viewingOld = $derived(selectedRunId != null && latestRunId != null && selectedRunId !== latestRunId);
  /** Entries are newest first; the strip reads left to right in time. */
  const strip = $derived.by(() => {
    // The window always holds the shown brief, however far back it is.
    const from = Math.max(0, step.index - STRIP + 1);
    return entries.slice(from, from + STRIP).reverse();
  });

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
    const to = ev.key === "ArrowLeft" ? step.older : ev.key === "ArrowRight" ? step.newer : null;
    if (!to) return;
    ev.preventDefault();
    const strip = ev.currentTarget as HTMLElement;
    onselect(to.runId);
    queueMicrotask(() => strip.querySelector<HTMLElement>(`[data-run="${to.runId}"]`)?.focus());
  }
</script>

<div class="runbar" data-testid="brief-runbar">
  {#if strip.length > 1}
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
      <RailButton icon="arrow-right" variant="ghost" onclick={() => latestRunId && onselect(latestRunId)} data-testid="brief-latest">Back to latest</RailButton>
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
