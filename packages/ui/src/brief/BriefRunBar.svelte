<script lang="ts">
  /**
   * The brief header's run controls: Create brief with its progress, and the
   * history navigator over index.jsonl. Briefs are made on demand, so every
   * label is the time a brief was created, never "today".
   */
  import LazyDropdown from "../common/LazyDropdown.svelte";
  import type { BriefCreateRun } from "./brief-create.svelte.js";
  import { BRIEF_FIX_LABEL, relativeRunLabel, stepRun, type BriefIndexEntry } from "./brief-runs.js";

  interface Props {
    entries: readonly BriefIndexEntry[];
    selectedRunId: string | null;
    latestRunId: string | null;
    now: Date;
    onselect: (runId: string) => void;
    create?: BriefCreateRun | null;
    /** Files the shown run is missing, by name. */
    missing?: readonly string[];
    oncreate?: () => void;
  }
  let { entries, selectedRunId, latestRunId, now, onselect, create = null, missing = [], oncreate }: Props = $props();

  const step = $derived(stepRun(entries, selectedRunId));
  const selected = $derived(entries.find((e) => e.runId === selectedRunId) ?? null);
  const viewingOld = $derived(selectedRunId != null && latestRunId != null && selectedRunId !== latestRunId);
  const phase = $derived(create?.phase ?? { kind: "idle" as const });
  let fixError = $state<string | null>(null);
  let fixing = $state(false);

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
  async function runFix(): Promise<void> {
    if (!create || fixing) return;
    fixing = true;
    fixError = await create.fix();
    fixing = false;
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

  {#if create}
    <div class="create" aria-live="polite">
      {#if phase.kind === "blocked"}
        <span class="msg" data-testid="brief-blocked">{phase.message}</span>
        <button type="button" class="btn" onclick={() => void runFix()} disabled={fixing} data-testid="brief-fix">
          {fixing ? "Working…" : BRIEF_FIX_LABEL[phase.fix]}
        </button>
        {#if fixError}<span class="msg">{fixError}</span>{/if}
      {/if}
      {#if phase.kind !== "blocked"}
        <button
          type="button"
          class="btn primary"
          disabled={create.busy}
          aria-busy={create.busy}
          onclick={() => (oncreate ? oncreate() : void create?.start())}
          data-testid="brief-create"
        >{create.busy ? "Creating…" : "Create brief"}</button>
      {/if}
    </div>
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
  .btn,
  .chip button {
    font: inherit;
    font-size: 13px;
    border: 0;
    border-radius: 999px;
    color: var(--b-t1);
    background: var(--b-card-hi);
    box-shadow: var(--b-raise);
    cursor: pointer;
  }
  .step {
    width: 26px;
    height: 26px;
  }
  .step:disabled,
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .btn {
    padding: 6px 12px;
  }
  .btn.primary {
    color: #1b1b1e;
    background: var(--b-sun);
  }
  .tag,
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: 999px;
    box-shadow: var(--b-well);
    color: var(--b-sun);
  }
  .chip button {
    padding: 2px 8px;
  }
  .miss {
    color: var(--b-warn);
  }
  .create {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
</style>
