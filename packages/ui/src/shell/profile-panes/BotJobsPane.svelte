<script lang="ts">
  /**
   * Jobs tab of the bot profile pane. The list shows each scheduled job's
   * derived name, schedule in plain words, next run, last run and outcome,
   * and whether it is on; failing jobs lead, then the soonest next run.
   * A row opens the detail: the full prompt with Copy, the schedule and
   * time zone, the run history the server reports, and the job controls
   * this account can use (Pause; resume and run-now are bot-only today).
   */
  import RailIcon from "../../common/button/RailIcon.svelte";
  import ReadLoader from "../../common/ReadLoader.svelte";
  import {
    JOB_FILTERS,
    JOB_FILTER_LABEL,
    filterJobs,
    lastRunLabel,
    nextRunLabel,
    sortJobs,
    type BotJob,
    type JobFilter,
  } from "./bot-jobs.js";

  interface Props {
    /** null while the first read is in flight. */
    jobs: BotJob[] | null;
    /** Plain-language reason when the list could not be read. */
    unavailable?: string | null;
    /** Pause one job; resolves false when the server refused. */
    onpause?: (jobId: string) => Promise<boolean>;
    now?: Date;
  }

  let { jobs, unavailable = null, onpause, now = new Date() }: Props = $props();

  let filter = $state<JobFilter>("all");
  let openId = $state<string | null>(null);
  let copied = $state(false);
  let pausing = $state(false);
  let pauseError = $state<string | null>(null);

  const sorted = $derived(sortJobs(jobs ?? []));
  const shown = $derived(filterJobs(sorted, filter));
  const open = $derived(openId ? (sorted.find((j) => j.id === openId) ?? null) : null);
  const counts = $derived(
    Object.fromEntries(JOB_FILTERS.map((f) => [f, filterJobs(sorted, f).length])) as Record<JobFilter, number>,
  );

  function absolute(iso: string | null, tz: string | null): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(tz ? { timeZone: tz, timeZoneName: "short" } : {}),
      }).format(new Date(t));
    } catch {
      return new Date(t).toLocaleString();
    }
  }

  function openJob(id: string): void {
    openId = id;
    copied = false;
    pauseError = null;
  }

  async function copyPrompt(prompt: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch (err) {
      console.warn("[hq-desktop] copy job prompt failed", err);
      copied = false;
    }
  }

  async function pause(id: string): Promise<void> {
    if (!onpause || pausing) return;
    pausing = true;
    pauseError = null;
    const ok = await onpause(id);
    pausing = false;
    if (!ok) pauseError = "Could not pause the job. Try again.";
  }
</script>

<div class="jobs" data-testid="bot-jobs">
  {#if open}
    <div class="detail" data-testid="bot-job-detail">
      <button type="button" class="back" data-testid="bot-job-back" onclick={() => (openId = null)}><RailIcon name="arrow-left" />All jobs</button>
      <div class="dh">
        <div class="dn" data-testid="bot-job-detail-name">{open.name}</div>
        <span class="state" class:off={!open.enabled}><i class="mk" class:off={!open.enabled} aria-hidden="true"></i><span data-testid="bot-job-detail-state">{open.enabled ? "On" : "Paused"}</span></span>
      </div>
      <section class="g">
        <div class="k">Prompt <button type="button" class="link" data-testid="bot-job-copy" onclick={() => void copyPrompt(open.prompt)}><RailIcon name="copy" />{copied ? "Copied" : "Copy"}</button></div>
        <pre class="prompt" data-testid="bot-job-prompt">{open.prompt}</pre>
      </section>
      <section class="g">
        <div class="k">Schedule</div>
        <div class="kv">
          <b>When</b><span data-testid="bot-job-detail-schedule">{open.schedule}</span>
          <b>Time zone</b><span>{open.timezone ?? "UTC"}</span>
          {#if open.expression}<b>Expression</b><span class="quiet">{open.expression}</span>{/if}
          {#if open.enabled && open.nextRunAt}<b>Next run</b><span>{absolute(open.nextRunAt, open.timezone)}</span>{/if}
        </div>
      </section>
      <section class="g">
        <div class="k">Run history</div>
        {#if open.lastRunAt}
          <div class="hist" data-testid="bot-job-history-row">
            <span class="mk" class:ok={open.lastOutcomeKind === "succeeded"} class:err={open.lastOutcomeKind === "failed"}></span>
            <span>{absolute(open.lastRunAt, open.timezone)}</span>
            <span class="trail" class:err={open.lastOutcomeKind === "failed"}>{open.lastOutcome ?? ""}</span>
          </div>
          <p class="note">Only the latest run is reported for now.</p>
        {:else}
          <p class="note">Not run yet.</p>
        {/if}
      </section>
      {#if (open.enabled && onpause) || pauseError}
        <section class="g controls">
          {#if open.enabled && onpause}
            <button type="button" class="btn" data-testid="bot-job-pause" disabled={pausing} onclick={() => void pause(open.id)}><RailIcon name="stop" />Pause</button>
          {/if}
          {#if pauseError}<p class="err" role="alert" data-testid="bot-job-pause-error">{pauseError}</p>{/if}
        </section>
      {/if}
    </div>
  {:else}
    <div class="chips" role="tablist" aria-label="Filter jobs">
      {#each JOB_FILTERS as id (id)}
        <button
          type="button"
          class="chip"
          role="tab"
          aria-selected={filter === id}
          data-testid={`bot-jobs-filter-${id}`}
          onclick={() => (filter = id)}
        >{JOB_FILTER_LABEL[id]}{#if jobs && counts[id] > 0}<span class="count">{counts[id]}</span>{/if}</button>
      {/each}
    </div>
    {#if jobs === null && !unavailable}
      <ReadLoader testid="bot-jobs-loading" />
    {:else if unavailable}
      <p class="note" data-testid="bot-jobs-unavailable">{unavailable}</p>
    {:else if sorted.length === 0}
      <p class="note" data-testid="bot-jobs-empty">No scheduled jobs.</p>
    {:else if shown.length === 0}
      <p class="note" data-testid="bot-jobs-filter-empty">No {JOB_FILTER_LABEL[filter].toLowerCase()} jobs. <button type="button" class="link inline" onclick={() => (filter = "all")}>Show all</button></p>
    {:else}
      <ul class="list">
        {#each shown as job (job.id)}
          <li>
            <button type="button" class="row" data-testid="bot-job-row" data-job-id={job.id} onclick={() => openJob(job.id)}>
              <span class="mk" class:err={job.lastOutcomeKind === "failed"} class:off={!job.enabled} aria-hidden="true"></span>
              <span class="main">
                <span class="t">{job.name}</span>
                <span class="meta">{job.schedule}</span>
                <span class="meta">
                  {#if !job.enabled}Paused{:else if job.nextRunAt}Next {nextRunLabel(job.nextRunAt, now)}{/if}{#if job.lastRunAt}{(!job.enabled || job.nextRunAt) ? " · " : ""}Last {lastRunLabel(job.lastRunAt, now)}{#if job.lastOutcome}, <span class:err={job.lastOutcomeKind === "failed"}>{job.lastOutcome}</span>{/if}{/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .jobs { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    height: 24px; padding: 0 8px; border: 0; border-radius: 6px;
    background: transparent; color: var(--v4-text-2); font: inherit; cursor: pointer;
  }
  .chip:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .chip[aria-selected="true"] { background: var(--sel, var(--v4-control-bg)); color: var(--v4-text-1); }
  .count { color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { border-bottom: 1px solid var(--v4-rowline, var(--line)); }
  .list li:last-child { border-bottom: 0; }
  .row {
    display: grid; grid-template-columns: 6px minmax(0, 1fr); gap: 10px; align-items: start;
    /* Bleed the hover fill past the column so the dot lines up with the text above. */
    width: calc(100% + 12px); margin: 0 -6px; padding: 8px 6px; border: 0; border-radius: 6px; background: transparent;
    color: var(--v4-text-1); font: inherit; text-align: left; cursor: pointer;
  }
  .row:hover { background: var(--hover, var(--v4-hover)); }
  .main { display: flex; flex-direction: column; min-width: 0; }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--v4-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .mk { width: 6px; height: 6px; border-radius: 50%; background: var(--v4-ok); margin-top: 7px; }
  .mk.off { background: transparent; box-shadow: inset 0 0 0 1px var(--v4-text-3); }
  .mk.err, .hist .mk.err { background: var(--v4-error); }
  .hist .mk { background: var(--v4-text-3); margin-top: 0; }
  .hist .mk.ok { background: var(--v4-ok); }
  .err { color: var(--v4-error); }
  p.err { margin: 0; }
  .note { margin: 0; color: var(--v4-text-3); }
  .link {
    display: inline-flex; align-items: center; gap: 4px;
    margin-left: auto; padding: 0; border: 0; background: none;
    color: var(--v4-text-3); font: inherit; font-weight: 400; cursor: pointer;
  }
  .link.inline { margin-left: 4px; text-decoration: underline; }
  .link:hover { color: var(--v4-text-1); }
  .back {
    display: inline-flex; align-items: center; gap: 4px; align-self: flex-start;
    padding: 0; border: 0; background: none; color: var(--v4-text-3); font: inherit; cursor: pointer;
  }
  .back:hover { color: var(--v4-text-1); }
  .detail { display: flex; flex-direction: column; gap: 12px; }
  .dh { display: flex; align-items: center; gap: 8px; }
  .dn { flex: 1; min-width: 0; color: var(--v4-text-1); font-size: 20px; line-height: 1.25; font-weight: 500; }
  .state { display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--v4-text-2); }
  .state.off { color: var(--v4-text-3); }
  .state .mk { margin-top: 0; }
  .g { border-top: 1px solid var(--v4-rowline, var(--line)); padding-top: 12px; }
  .k { color: var(--v4-text-2); font-weight: 500; display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .prompt {
    margin: 0; max-height: 240px; overflow: auto;
    color: var(--v4-text-1); font: inherit; white-space: pre-wrap; word-break: break-word;
  }
  .kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 12px; color: var(--v4-text-1); }
  .kv b { font-weight: 400; color: var(--v4-text-3); }
  .quiet { color: var(--v4-text-3); overflow-wrap: anywhere; }
  .hist { display: grid; grid-template-columns: 6px minmax(0, 1fr) auto; gap: 8px; align-items: center; color: var(--v4-text-1); }
  .trail { color: var(--v4-text-3); }
  .trail.err { color: var(--v4-error); }
  .hist + .note { margin-top: 6px; }
  .controls { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    height: var(--hq-btn-h); padding: 0 var(--hq-btn-pad-inline);
    border: 1px solid var(--v4-control-border, var(--line2)); border-radius: var(--v4-radius-button, 6px);
    background: transparent; color: var(--v4-text-1); font: inherit; cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .btn:disabled { opacity: 0.5; cursor: default; }
</style>
