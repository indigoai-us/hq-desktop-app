<script lang="ts">
  /**
   * Personal Outpost (US-034).
   * First frame is the cache. Refresh runs after paint.
   * Offline disables host actions and shows the retry countdown.
   */
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import {
    alertLabel,
    appendLogTail,
    clampJobAlert,
    filterJobs,
    filterRuns,
    fixtureOutpost,
    formatRetry,
    metadata,
    presetCron,
    previewCron,
    readOutpostCache,
    visibleLogWindow,
    writeOutpostCache,
    type JobAlert,
    type JobCadence,
    type JobRunMode,
    type LogLine,
    type OutpostCache,
    type OutpostJob,
    type OutpostTab,
  } from "./outpost-model.js";

  export { metadata };

  let data = $state<OutpostCache>(readOutpostCache("personal") ?? fixtureOutpost());
  let tab = $state<OutpostTab>("overview");
  let jobFilter = $state<"all" | "active" | "paused" | "failing">("all");
  let runFilter = $state<"all" | "ok" | "failed" | "running">("all");
  let logFilter = $state<"all" | "info" | "warn" | "err">("all");
  let selectedJob = $state("attio-call-sync");
  let sheet = $state<OutpostJob | null>(null);
  let draftCadence = $state<JobCadence>("hourly");
  let draftCron = $state("0 * * * *");
  let draftMode = $state<JobRunMode>("prompt");
  let draftAlert = $state<JobAlert>("dm");
  let draftPrompt = $state("");
  let draftSkill = $state("");
  let draftArgs = $state("");
  let logScroll = $state(0);
  let notice = $state("");

  const ROW = 22;
  const VIEW = 280;

  $effect(() => {
    const cached = readOutpostCache("personal");
    if (cached) data = cached;
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const next = readOutpostCache("personal") ?? fixtureOutpost();
      writeOutpostCache("personal", next);
      data = next;
    });
    return () => {
      live = false;
    };
  });

  const jobs = $derived(filterJobs(data.jobs, jobFilter));
  const runs = $derived(filterRuns(data.runs, runFilter));
  const filteredLogs = $derived(
    data.logs.filter((line) => logFilter === "all" || line.level === logFilter),
  );
  const logWindow = $derived(visibleLogWindow(filteredLogs.length, logScroll, VIEW, ROW));
  const paintedLogs = $derived(filteredLogs.slice(logWindow.start, logWindow.end));
  const cronPreview = $derived(previewCron(draftCron, new Date("2026-10-01T18:00:00Z"), 5));
  const offline = $derived(data.unreachable || !data.host.online);

  function openEdit(job: OutpostJob): void {
    sheet = job;
    draftCadence = job.cadence;
    draftCron = job.cron;
    draftMode = job.mode;
    draftAlert = clampJobAlert(job.alert);
    draftPrompt = job.prompt;
    draftSkill = job.skill;
    draftArgs = job.args;
  }

  function setCadence(next: JobCadence): void {
    draftCadence = next;
    if (next !== "custom") draftCron = presetCron(next);
  }

  function saveJob(): void {
    if (!sheet) return;
    if (draftCadence === "custom" && !cronPreview.ok) {
      notice = cronPreview.error;
      return;
    }
    const alert = clampJobAlert(draftAlert);
    data = {
      ...data,
      jobs: data.jobs.map((job) =>
        job.id === sheet?.id
          ? {
              ...job,
              cadence: draftCadence,
              cron: draftCron,
              mode: draftMode,
              alert,
              prompt: draftPrompt,
              skill: draftSkill,
              args: draftArgs,
            }
          : job,
      ),
    };
    writeOutpostCache("personal", data);
    notice = "";
    sheet = null;
  }

  function togglePause(job: OutpostJob): void {
    if (offline) return;
    data = {
      ...data,
      jobs: data.jobs.map((row) => (row.id === job.id ? { ...row, paused: !row.paused, nextRun: row.paused ? "in 33m" : "paused" } : row)),
    };
    writeOutpostCache("personal", data);
  }

  function streamMore(): void {
    const incoming: LogLine[] = [
      {
        id: `live-${data.logs.length + 1}`,
        t: "10:16:01.004",
        level: "info",
        job: "outpost",
        message: "tail · heartbeat ok",
      },
    ];
    data = { ...data, logs: appendLogTail(data.logs, incoming) };
    writeOutpostCache("personal", data);
  }

  function retryNow(): void {
    data = { ...data, retryInSec: Math.max(0, data.retryInSec - 1) };
  }

  function markUnreachable(): void {
    data = { ...data, unreachable: true, host: { ...data.host, online: false } };
    writeOutpostCache("personal", data);
  }
</script>

<div class="page" data-testid="outpost-page" data-tab={tab} data-offline={offline ? "true" : "false"}>
  <aside class="pane" aria-label="Outpost">
    <div class="pane-head">Outpost <span class="chip" class:live={!offline} class:err={offline}>{offline ? "down" : "up"}</span></div>
    <nav>
      {#each [["overview", "Overview"], ["jobs", "Scheduled jobs"], ["runs", "Runs"], ["logs", "Logs"], ["settings", "Settings"]] as item (item[0])}
        <button type="button" class:on={tab === item[0]} aria-current={tab === item[0] ? "true" : undefined} onclick={() => (tab = item[0] as OutpostTab)}>{item[1]}</button>
      {/each}
    </nav>
  </aside>
  <main>
    <header class="toolbar">
      <h1>{tab === "overview" ? "Outpost" : tab === "jobs" ? "Scheduled jobs" : tab === "runs" ? "Runs" : tab === "logs" ? "Logs" : "Settings"}</h1>
      <span class="sub">{data.host.name} · {data.host.region}</span>
      <span class="chip" class:live={!offline} class:err={offline}>{offline ? "Unreachable" : "Online"}</span>
      <span class="grow"></span>
      <button type="button" class="btn" disabled={offline} onclick={() => (notice = "terminal")}>Open terminal</button>
      <button type="button" class="btn" disabled={offline}>Self-update</button>
      <button type="button" class="btn" disabled={offline}>Restart</button>
    </header>

    {#if offline}
      <div class="banner" role="alert" data-testid="outpost-offline-banner">
        <b>Host unreachable.</b>
        No heartbeat since {data.host.lastHeartbeatAt}.
        <span class="mono">Retrying in {formatRetry(data.retryInSec)} · attempt {data.retryAttempt}</span>
        <button type="button" class="btn" onclick={retryNow}>Retry now</button>
        <button type="button" class="btn" onclick={() => (tab = "logs")}>Last logs</button>
      </div>
    {/if}

    {#if tab === "overview" || tab === "jobs"}
      <section>
        <div class="tabs">
          {#each ["all", "active", "paused", "failing"] as name (name)}
            <button type="button" class:on={jobFilter === name} onclick={() => (jobFilter = name as typeof jobFilter)}>{name}</button>
          {/each}
          <button type="button" class="btn primary" disabled={offline} onclick={() => openEdit(data.jobs[0])}>New job</button>
        </div>
        <div class="jrow hd"><span>Job</span><span>Cadence</span><span>Next run</span><span>Last result</span><span>Alerts</span><span></span></div>
        {#each jobs as job (job.id)}
          <div class="jrow" class:paused={job.paused} aria-current={selectedJob === job.id ? "true" : undefined} role="button" tabindex="0" onclick={() => (selectedJob = job.id)} onkeydown={(e) => e.key === "Enter" && (selectedJob = job.id)}>
            <span><b>{job.name}</b><small>{job.detail}</small></span>
            <span class="mono">{job.cadenceLabel}</span>
            <span class="mono">{job.nextRun}</span>
            <span class="st {job.status}">{job.lastResult}</span>
            <span class="mono" data-testid="job-alert">{alertLabel(job.alert, job.alertWhen)}</span>
            <span class="act">
              <button type="button" class="tab" disabled={offline} onclick={(e) => { e.stopPropagation(); togglePause(job); }}>{job.paused ? "Resume" : "Pause"}</button>
              <button type="button" class="tab" onclick={(e) => { e.stopPropagation(); openEdit(job); }}>Edit</button>
            </span>
          </div>
        {/each}
      </section>
    {/if}

    {#if tab === "overview" || tab === "runs"}
      <section data-testid="outpost-runs">
        <div class="tabs">
          {#each ["all", "ok", "failed", "running"] as name (name)}
            <button type="button" class:on={runFilter === name} onclick={() => (runFilter = name as typeof runFilter)}>{name}</button>
          {/each}
        </div>
        {#each runs as run (run.id)}
          <div class="run"><b>{run.job}</b><span>{run.when} · {run.detail}</span><span class="st {run.status}">{run.status}</span></div>
        {/each}
      </section>
    {/if}

    {#if tab === "logs"}
      <section data-testid="outpost-logs">
        <div class="tabs">
          {#each ["all", "info", "warn", "err"] as name (name)}
            <button type="button" class:on={logFilter === name} onclick={() => (logFilter = name as typeof logFilter)}>{name}</button>
          {/each}
          <button type="button" class="btn" data-testid="stream-logs" onclick={streamMore}>Follow</button>
        </div>
        <div
          class="log-view"
          data-testid="log-view"
          style="height:{VIEW}px"
          onscroll={(e) => (logScroll = (e.currentTarget as HTMLDivElement).scrollTop)}
        >
          <div style="height:{logWindow.heightPx}px; position:relative">
            <div style="transform:translateY({logWindow.offsetPx}px)">
              {#each paintedLogs as line (line.id)}
                <div class="ln {line.level}" style="height:{ROW}px" data-testid="log-line"><span class="mono">{line.t}</span> {line.job} {line.message}</div>
              {/each}
            </div>
          </div>
        </div>
      </section>
    {/if}

    {#if tab === "settings"}
      <section data-testid="outpost-settings">
        <h2>Host</h2>
        <p>{data.host.hostname}</p>
        <p>SSH fingerprint is shown. The private key stays on this Mac.</p>
        <p class="mono">SHA256:4kq9…K5E</p>
        <h2>Alerts</h2>
        <div class="seg" role="group" aria-label="Alert profile">
          <button type="button" class:on={true}>DM</button>
          <button type="button">None</button>
        </div>
        <p>Per-job alerts are dm or none. Secret values are not stored on the Outpost disk.</p>
        <button type="button" class="btn" data-testid="mark-unreachable" onclick={markUnreachable}>Mark unreachable</button>
      </section>
    {/if}
  </main>

  {#if sheet}
    <div class="ov" data-testid="edit-job-sheet">
      <div class="sheet" role="dialog" aria-label="Edit job">
        <header>Edit job <span class="sub">{sheet.name} · {data.host.name}</span>
          <button type="button" aria-label="Close" onclick={() => (sheet = null)}>✕</button>
        </header>
        <div class="body">
          <span class="lbl">Cadence</span>
          <div class="seg">
            {#each ["hourly", "daily", "weekdays", "weekly", "custom"] as name (name)}
              <button type="button" class:on={draftCadence === name} onclick={() => setCadence(name as JobCadence)}>{name}</button>
            {/each}
          </div>
          {#if draftCadence === "custom"}
            <label class="lbl" for="cron">Cron expression</label>
            <input id="cron" data-testid="cron-input" bind:value={draftCron} />
            {#if cronPreview.ok}
              <ol data-testid="cron-next">
                {#each cronPreview.next as when, i (i)}
                  <li>{when.toISOString()}</li>
                {/each}
              </ol>
            {:else}
              <p class="err" data-testid="cron-error">{cronPreview.error}</p>
            {/if}
          {:else}
            <p class="mono">cron {draftCron}</p>
          {/if}
          <span class="lbl">Run</span>
          <div class="seg">
            <button type="button" class:on={draftMode === "prompt"} onclick={() => (draftMode = "prompt")}>Prompt</button>
            <button type="button" class:on={draftMode === "skill"} onclick={() => (draftMode = "skill")}>Skill</button>
          </div>
          {#if draftMode === "skill"}
            <input data-testid="skill-input" bind:value={draftSkill} />
            <input data-testid="args-input" bind:value={draftArgs} />
            <p class="mono">$ hq run {draftSkill} {draftArgs}</p>
          {:else}
            <textarea data-testid="prompt-input" bind:value={draftPrompt}></textarea>
          {/if}
          <span class="lbl">Alerts</span>
          <div class="seg" data-testid="alert-seg">
            <button type="button" class:on={draftAlert === "dm"} onclick={() => (draftAlert = "dm")}>DM</button>
            <button type="button" class:on={draftAlert === "none"} onclick={() => (draftAlert = "none")}>None</button>
          </div>
          {#if notice}<p class="err">{notice}</p>{/if}
        </div>
        <footer>
          <button type="button" onclick={() => (sheet = null)}>Cancel</button>
          <button type="button" class="btn primary" data-testid="save-job" onclick={saveJob}>Save</button>
        </footer>
      </div>
    </div>
  {/if}
</div>

<style>
  .page { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; min-height: 0; color: var(--v4-text-1); background: var(--v4-ground); font-family: var(--font-sans); position: relative; }
  .pane { border-right: 1px solid var(--v4-hairline); padding: 12px; }
  .pane-head, h1 { font-size: 15px; font-weight: 600; }
  nav { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
  nav button, .tabs button, .seg button, .tab, .btn { background: transparent; color: var(--v4-text-2); border: 0; border-radius: 6px; text-align: left; padding: 4px 8px; font: inherit; }
  nav button.on, .jrow[aria-current="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  nav button:hover, .jrow:hover { background: var(--v4-hover); }
  main { min-width: 0; overflow: auto; padding: 12px 16px 24px; }
  .toolbar { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1; }
  .sub, small, .mono { color: var(--v4-text-3); font-size: 12px; }
  .mono { font-family: var(--font-mono); }
  .chip.live { color: var(--v4-ok); }
  .chip.err, .st.failed, .err, .ln.err { color: var(--v4-error); }
  .banner { display: flex; gap: 8px; align-items: center; height: 40px; padding: 0 8px; background: var(--v4-control-faint); border-bottom: 1px solid var(--v4-rowline); font-size: 12px; }
  .jrow { display: grid; grid-template-columns: minmax(0, 1.8fr) 120px 100px minmax(0, 1fr) 90px 120px; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--v4-rowline); font-size: 13px; }
  .jrow small { display: block; }
  .jrow.hd { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .act { display: flex; gap: 4px; justify-content: flex-end; }
  .run { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--v4-rowline); font-size: 12px; }
  .log-view { overflow: auto; border-top: 1px solid var(--v4-rowline); font-family: var(--font-mono); font-size: 11px; }
  .seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--v4-control-border); border-radius: 6px; background: var(--v4-control-faint); }
  .seg button.on { background: var(--v4-active-row); color: var(--v4-text-1); }
  .ov { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); }
  .sheet { width: 480px; max-height: calc(100% - 48px); overflow: auto; background: var(--v4-popover); border: 1px solid var(--v4-hairline); border-radius: 8px; box-shadow: var(--v4-shadow-popover); }
  .sheet header, .sheet footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--v4-hairline); }
  .sheet footer { border-bottom: 0; border-top: 1px solid var(--v4-hairline); }
  .body { padding: 8px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
  input, textarea { background: var(--v4-control-faint); color: var(--v4-text-1); border: 1px solid var(--v4-control-border); border-radius: 6px; padding: 6px 8px; font: inherit; }
  button:disabled { opacity: 0.45; }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); }
</style>
