<script lang="ts">
  /**
   * The brief header's run row: the history navigator over index.jsonl, the
   * "viewing an older brief" chip and missing files. Create brief / Refresh
   * sits on the title row (BriefCreateButton). Briefs are made on demand, so every
   * label is the time a brief was created, never "today".
   */
  import LazyDropdown from "../common/LazyDropdown.svelte";
  import { relativeRunLabel, stepRun, type BriefIndexEntry } from "./brief-runs.js";

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

  const step = $derived(stepRun(entries, selectedRunId));
  const selected = $derived(entries.find((e) => e.runId === selectedRunId) ?? null);
  const viewingOld = $derived(selectedRunId != null && latestRunId != null && selectedRunId !== latestRunId);

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
  function dateLabel(iso: string): string {
    return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
</script>

<div class="runbar" data-testid="brief-runbar">
  {#if entries.length}
    <div class="hist" role="group" aria-label="Brief history">
      <button
        type="button"
        class="step"
        aria-label="Older brief"
        disabled={!step.older}
        onclick={() => step.older && onselect(step.older.runId)}
        data-testid="brief-older"
      >‹</button>
      <LazyDropdown
        value={selectedRunId ?? ""}
        options={entries.map((e) => ({ value: e.runId, label: optionLabel(e), detail: countsLabel(e) }))}
        label="Choose a brief"
        testid="brief-history"
        pill
        onchange={(id) => onselect(id)}
      />
      <button
        type="button"
        class="step"
        aria-label="Newer brief"
        disabled={!step.newer}
        onclick={() => step.newer && onselect(step.newer.runId)}
        data-testid="brief-newer"
      >›</button>
      {#if selected?.catchUp}<span class="tag" data-testid="brief-catchup-tag">Catch-up</span>{/if}
    </div>
  {/if}

  {#if viewingOld && selected}
    <span class="chip" data-testid="brief-viewing">
      Viewing {dateLabel(selected.createdAt)}
      <button type="button" onclick={() => latestRunId && onselect(latestRunId)} data-testid="brief-latest">Back to latest</button>
    </span>
  {/if}

  {#if missing.length}
    <span class="miss" data-testid="brief-missing">Missing from this brief: {missing.join(", ")}</span>
  {/if}

</div>

<style>
  .runbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--b-t2);
  }
  .hist {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .step,
  .chip button {
    font: inherit;
    font-size: 13px;
    border: 0;
    border-radius: 8px;
    color: var(--b-t1);
    background: var(--b-card-hi);
    box-shadow: var(--b-raise);
    cursor: pointer;
  }
  .step {
    width: 26px;
    height: 26px;
  }
  .step:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tag,
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: 8px;
    box-shadow: var(--b-well);
    color: var(--b-sun);
  }
  .chip button {
    padding: 2px 8px;
  }
  .miss {
    color: var(--b-warn);
  }
</style>
