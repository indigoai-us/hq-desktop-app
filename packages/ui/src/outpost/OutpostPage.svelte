<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  /**
   * Personal Outpost (US-034).
   * First frame is the cache. Refresh runs after paint, then every 60 s while
   * visible; relative times re-render every 30 s from absolute timestamps
   * (QA-069). A failed refresh keeps the cache and says so in the header.
   * Offline disables host actions and shows the retry countdown.
   */
  import { untrack } from "svelte";
  import { startNowTicker } from "../common/now-ticker.js";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import {
    alertLabel,
    clampJobAlert,
    filterJobs,
    filterRuns,
    blankJob,
    freshnessLabel,
    lastResultLabel,
    metadata,
    nextRunLabel,
    OUTPOST_REFRESH_MS,
    runWhenLabel,
    presetCron,
    previewCron,
    readOutpostCache,
    visibleLogWindow,
    withReadTimeout,
    writeOutpostCache,
    type JobAlert,
    type JobCadence,
    type JobRunMode,
    type OutpostCache,
    type OutpostJob,
    type OutpostRefresher,
    type OutpostTab,
  } from "./outpost-model.js";
  import { createOutpostRefresher, noOutpost, OUTPOST_SETUP_URL, type OutpostReadApi } from "./outpost-live.js";

  export { metadata };

  interface Props {
    /** Reads live state from the Outpost. Wins over `api` (tests). */
    refresh?: OutpostRefresher;
    /** The desktop hq-pro client; the page reads the user's Outpost through it. */
    api?: OutpostReadApi | null;
    openExternal?: (url: string) => void;
  }

  let { refresh, api = null, openExternal }: Props = $props();

  // First frame is the cache from the last real read, or an unknown state.
  // Nothing here is sample data: rows only come from hq-pro.
  let data = $state<OutpostCache>(readOutpostCache("personal") ?? { ...noOutpost(null), provisioned: null });
  let tab = $state<OutpostTab>("overview");
  let jobFilter = $state<"all" | "active" | "paused" | "failing">("all");
  let runFilter = $state<"all" | "ok" | "failed" | "running">("all");
  let logFilter = $state<"all" | "info" | "warn" | "err">("all");
  let selectedJob = $state("");
  let sheet = $state<OutpostJob | null>(null);
  let draftName = $state("");
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

  let now = $state(Date.now());
  let refreshFailed = $state(false);

  // Paint the cache, then refresh in the background on open and every 60 s
  // while the page is visible. Success merges into the cache; failure keeps
  // the cached data, logs the cause, and shows the stale state.
  $effect(() => {
    const read = refresh ?? createOutpostRefresher(api);
    untrack(() => {
      const cached = readOutpostCache("personal");
      if (cached) data = cached;
    });
    let live = true;
    const run = async (): Promise<void> => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const next = await withReadTimeout(read());
        if (!live) return;
        const merged = { ...next, fetchedAt: next.fetchedAt ?? new Date().toISOString() };
        writeOutpostCache("personal", merged);
        data = merged;
        refreshFailed = false;
      } catch (err) {
        console.error("[outpost] refresh failed", err);
        if (live) refreshFailed = true;
      } finally {
        if (live) now = Date.now();
      }
    };
    void run();
    retry = () => void run();
    const timer = setInterval(() => void run(), OUTPOST_REFRESH_MS);
    const stopTick = startNowTicker((t) => (now = t));
    return () => {
      live = false;
      clearInterval(timer);
      stopTick();
    };
  });

  let retry = $state<() => void>(() => {});

  const freshness = $derived(freshnessLabel(data.fetchedAt, refreshFailed, now));

  const jobs = $derived(filterJobs(data.jobs, jobFilter));
  const runs = $derived(filterRuns(data.runs, runFilter));
  const filteredLogs = $derived(
    data.logs.filter((line) => logFilter === "all" || line.level === logFilter),
  );
  const logWindow = $derived(visibleLogWindow(filteredLogs.length, logScroll, VIEW, ROW));
  const paintedLogs = $derived(filteredLogs.slice(logWindow.start, logWindow.end));
  const cronPreview = $derived(previewCron(draftCron, new Date(now), 5));
  const provisioned = $derived(data.provisioned === true);
  const offline = $derived(!provisioned || data.unreachable || !data.host.online);

  // QA-053: New job opens a blank sheet; Edit keeps the job's values.
  const sheetIsNew = $derived(sheet != null && !data.jobs.some((job) => job.id === sheet?.id));

  function openNew(): void {
    openEdit(blankJob());
  }

  function openEdit(job: OutpostJob): void {
    sheet = job;
    draftName = job.name;
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
    if (sheetIsNew) {
      const name = draftName.trim();
      if (!name) {
        notice = "Name the job before saving.";
        return;
      }
      data = {
        ...data,
        jobs: [
          ...data.jobs,
          {
            ...sheet,
            name,
            cadence: draftCadence,
            cadenceLabel: draftCadence === "custom" ? draftCron : draftCadence,
            cron: draftCron,
            mode: draftMode,
            alert,
            prompt: draftPrompt,
            skill: draftSkill,
            args: draftArgs,
          },
        ],
      };
      writeOutpostCache("personal", data);
      notice = "";
      sheet = null;
      return;
    }
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
      jobs: data.jobs.map((row) => (row.id === job.id ? { ...row, paused: !row.paused, nextRun: row.paused ? "" : "paused" } : row)),
    };
    writeOutpostCache("personal", data);
  }

</script>

<div class="page" data-testid="outpost-page" data-tab={tab} data-offline={offline ? "true" : "false"}>
  <aside class="pane" aria-label="Outpost">
    <div class="pane-head"><span class="status"><span class="dot" class:live={!offline} class:err={offline}></span>{provisioned ? `${data.host.name} · ${offline ? "Down" : "Up"}` : "Outpost"}</span></div>
    <nav>
      {#each [["overview", "Overview"], ["jobs", "Scheduled jobs"], ["runs", "Runs"], ["logs", "Logs"], ["settings", "Settings"]] as item (item[0])}
        <button type="button" class:on={tab === item[0]} aria-current={tab === item[0] ? "true" : undefined} onclick={() => (tab = item[0] as OutpostTab)}>{item[1]}</button>
      {/each}
    </nav>
  </aside>
  <main>
    <header class="toolbar">
      <h1>{tab === "overview" ? "Outpost" : tab === "jobs" ? "Scheduled jobs" : tab === "runs" ? "Runs" : tab === "logs" ? "Logs" : "Settings"}</h1>
      {#if provisioned}
        <span class="sub" data-testid="outpost-host">{[data.host.name, data.host.region, data.host.instance].filter(Boolean).join(" · ")}</span>
        <span class="status" data-testid="outpost-online"><span class="dot" class:live={!offline} class:err={offline}></span>{offline ? "Offline" : "Online"}</span>
      {/if}
      <span class="sub" class:err={refreshFailed} data-testid="outpost-freshness">{freshness}</span>
      <span class="grow"></span>
      <button type="button" class="btn" disabled={offline} onclick={() => (notice = "terminal")}>Open terminal</button>
      <button type="button" class="btn" disabled={offline}>Self-update</button>
      <button type="button" class="btn" disabled={offline}>Restart</button>
    </header>

    {#if data.provisioned === false}
      <div class="empty" data-testid="outpost-empty">
        <span class="nm">No Outpost yet</span>
        <span class="sub">An Outpost is your always-on machine in the cloud for scheduled jobs.</span>
        <button type="button" class="btn primary" data-testid="outpost-setup" onclick={() => openExternal?.(OUTPOST_SETUP_URL)}>Set one up</button>
      </div>
    {:else if data.provisioned === null && refreshFailed}
      <div class="empty" role="alert" data-testid="outpost-load-error">
        <span class="nm">Couldn't read your Outpost</span>
        <button type="button" class="btn" data-testid="outpost-try-again" onclick={() => retry()}>Try again</button>
      </div>
    {:else if data.provisioned === null && tab !== "logs"}
      <div class="empty sub" data-testid="outpost-loading">Reading your Outpost…</div>
    {:else if offline}
      <div class="banner" role="alert" data-testid="outpost-offline-banner">
        <span class="nm">Host unreachable.</span>
        No report since {data.host.lastHeartbeatAt}.
        <button type="button" class="btn" onclick={() => retry()}>Retry now</button>
      </div>
    {/if}

    {#if provisioned}

    {#if tab === "overview" || tab === "jobs"}
      <section>
        <div class="tabs">
          {#each ["all", "active", "paused", "failing"] as name (name)}
            <button type="button" class:on={jobFilter === name} onclick={() => (jobFilter = name as typeof jobFilter)}>{name}</button>
          {/each}
          <button type="button" class="btn primary" disabled={offline} data-testid="new-job" onclick={openNew}>New job</button>
        </div>
        <div class="jrow hd"><span>Job</span><span>Cadence</span><span>Next run</span><span>Last result</span><span>Alerts</span><span></span></div>
        {#if data.jobs.length === 0}
          <p class="sub" data-testid="outpost-no-jobs">No scheduled jobs</p>
        {/if}
        {#each jobs as job (job.id)}
          <div class="jrow" class:paused={job.paused} aria-current={selectedJob === job.id ? "true" : undefined} role="button" tabindex="0" onclick={() => (selectedJob = job.id)} onkeydown={(e) => e.key === "Enter" && (selectedJob = job.id)}>
            <span class="cell"><span class="nm">{job.name}</span><small>{job.detail}</small></span>
            <span>{job.cadenceLabel}</span>
            <span data-testid="job-next-run">{nextRunLabel(job, now)}</span>
            <span class="st result {job.status}" data-testid="job-last-result" title={lastResultLabel(job, now)}>{lastResultLabel(job, now)}</span>
            <span data-testid="job-alert">{alertLabel(job.alert, job.alertWhen)}</span>
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
        {#if data.runs.length === 0}
          <p class="sub" data-testid="outpost-no-runs">No runs yet</p>
        {/if}
        {#each runs as run (run.id)}
          <div class="run"><span class="nm">{run.job}</span><span class="cell sub" data-testid="run-when">{runWhenLabel(run, now)} · {run.detail}</span><span class="st {run.status}"><span class="dot" class:live={run.status === "running"} class:err={run.status === "failed"}></span>{run.status}</span></div>
        {/each}
      </section>
    {/if}

    {/if}

    {#if tab === "logs" && data.provisioned !== false && !(data.provisioned === null && refreshFailed)}
      <section data-testid="outpost-logs">
        <div class="tabs">
          {#each ["all", "info", "warn", "err"] as name (name)}
            <button type="button" class:on={logFilter === name} onclick={() => (logFilter = name as typeof logFilter)}>{name}</button>
          {/each}
        </div>
        {#if data.logs.length === 0}
          <p class="sub" data-testid="outpost-no-logs">No logs from the Outpost yet</p>
        {/if}
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

    {#if provisioned && tab === "settings"}
      <section data-testid="outpost-settings">
        <h2>Host</h2>
        <p>{data.host.name}{data.host.hostname ? ` · ${data.host.hostname}` : ""}</p>
        <p>{data.host.instance}</p>
        {#if data.host.diskUsed}<p>Disk {data.host.diskUsed} of {data.host.diskTotal}</p>{/if}
        <p>Per-job alerts are dm or none. Secret values are not stored on the Outpost disk.</p>
      </section>
    {/if}
  </main>

  {#if sheet}
    <div class="ov" data-testid="edit-job-sheet">
      <div class="sheet" role="dialog" aria-label={sheetIsNew ? "New job" : "Edit job"} use:dismissable={{ onclose: () => (sheet = null), outside: true }}>
        <header>{sheetIsNew ? "New job" : "Edit job"} <span class="sub">{sheetIsNew ? data.host.name : `${sheet.name} · ${data.host.name}`}</span>
          <button type="button" aria-label="Close" onclick={() => (sheet = null)}>✕</button>
        </header>
        <div class="body">
          {#if sheetIsNew}
            <label class="lbl" for="job-name">Name</label>
            <input id="job-name" data-testid="job-name-input" bind:value={draftName} />
          {/if}
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
  /* Console-rail chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px Geist everywhere else, 31px rows, status as dot plus
     text, mono only for the fingerprint, cron, commands and log lines. */
  .page { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; min-height: 0; color: var(--t1, var(--v4-text-1)); background: var(--v4-ground); font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif); position: relative; }
  .pane { border-right: 1px solid var(--line, var(--v4-hairline)); padding: 12px 14px; }
  .pane-head { height: 31px; display: flex; align-items: center; padding: 0 8px; color: var(--t2, var(--v4-text-2)); }
  h1 { font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); margin: 0 4px 0 0; }
  h2 { font-size: 13px; font-weight: 500; color: var(--t2, var(--v4-text-2)); margin: 16px 0 4px; }
  nav { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; }
  button { font: inherit; font-size: 13px; cursor: pointer; }
  nav button, .tabs button, .seg button, .tab, .btn, .sheet header button, .sheet footer button { background: transparent; color: var(--t2, var(--v4-text-2)); border: 0; border-radius: 6px; text-align: left; padding: 0 8px; height: 26px; }
  nav button { height: 31px; padding: 7px 8px; border-radius: 8px; }
  nav button.on, .jrow[aria-current="true"], .tabs button.on { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  nav button:hover, .jrow:hover, .tab:hover, .tabs button:hover { background: var(--hover, var(--v4-hover)); }
  main { min-width: 0; overflow: auto; padding: 0 20px 24px; }
  .toolbar { display: flex; align-items: center; gap: 8px; height: 52px; margin: 0 -20px 12px; padding: 0 20px; box-sizing: border-box; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  section { margin-bottom: 20px; }
  .grow { flex: 1; }
  .sub, small { color: var(--t3, var(--v4-text-3)); font-size: 13px; }
  .mono { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); color: var(--t2, var(--v4-text-2)); }
  .nm { color: var(--t1, var(--v4-text-1)); font-weight: 400; }
  .cell { display: flex; gap: 8px; min-width: 0; align-items: baseline; }
  .status, .st { display: inline-flex; align-items: center; gap: 6px; color: var(--t2, var(--v4-text-2)); white-space: nowrap; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); flex: none; display: inline-block; }
  .dot.live { background: var(--ok, var(--v4-ok)); }
  .dot.err { background: var(--red, var(--v4-error)); }
  .st.failed, .err, .ln.err { color: var(--red, var(--v4-error)); }
  .empty { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding: 24px 0; }
  .banner { display: flex; gap: 8px; align-items: center; min-height: 40px; margin: 0 0 12px; padding: 0 12px; background: var(--raised, var(--v4-control-faint)); border-radius: 8px; }
  .tabs { display: flex; align-items: center; gap: 2px; margin-bottom: 4px; }
  .tabs .btn { margin-left: auto; }
  .jrow { display: grid; grid-template-columns: minmax(0, 1.8fr) 120px 100px minmax(0, 1fr) 90px 120px; gap: 8px; align-items: center; height: 31px; box-sizing: border-box; padding: 0 8px; border-radius: 8px; cursor: pointer; }
  .jrow > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* QA-052: at narrow widths the last result wraps instead of clipping the
     time, duration, and failure streak. The row grows to fit. */
  .jrow:not(.hd) { height: auto; min-height: 31px; padding-block: 6px; }
  .jrow > .st.result { display: block; white-space: normal; overflow: visible; overflow-wrap: anywhere; }
  .jrow.paused { color: var(--t3, var(--v4-text-3)); }
  .jrow.hd { color: var(--t3, var(--v4-text-3)); cursor: default; }
  .jrow.hd:hover { background: transparent; }
  .act { display: flex; gap: 2px; justify-content: flex-end; }
  .run { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto; gap: 8px; align-items: center; height: 31px; padding: 0 8px; }
  .run > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-view { overflow: auto; border-top: 1px solid var(--line, var(--v4-rowline)); font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); font-size: 12px; }
  .seg { display: inline-flex; gap: 2px; padding: 2px; width: max-content; border: 1px solid var(--panel-border, var(--v4-control-border)); border-radius: 6px; background: var(--hover, var(--v4-control-faint)); }
  .seg button { height: auto; padding: 4px 8px; border-radius: 4px; }
  .seg button.on { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); }
  .ov { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); }
  .sheet { width: 480px; max-height: calc(100% - 48px); overflow: auto; background: var(--panel-bg, var(--v4-popover)); border: 1px solid var(--panel-border, var(--v4-hairline)); border-radius: 8px; box-shadow: var(--panel-shadow, var(--v4-shadow-popover)); }
  .sheet header { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 10px 0 20px; font-weight: 500; border-bottom: 1px solid var(--line, var(--v4-hairline)); }
  .sheet header button { margin-left: auto; width: 24px; padding: 0; text-align: center; }
  .sheet footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line, var(--v4-hairline)); }
  .body { padding: 12px 20px 16px; display: flex; flex-direction: column; gap: 8px; }
  .lbl { color: var(--t2, var(--v4-text-2)); }
  input, textarea { background: var(--btn-bg, var(--v4-control-faint)); color: var(--t1, var(--v4-text-1)); border: 1px solid var(--line2, var(--v4-control-border)); border-radius: 6px; padding: 0 8px; font: inherit; font-size: 13px; }
  input { height: 28px; box-sizing: border-box; }
  textarea { padding: 6px 8px; min-height: 80px; }
  button:disabled { opacity: 0.45; cursor: default; }
  .btn { height: 28px; padding: 0 10px; border: 1px solid var(--line2, var(--v4-control-border)); background: var(--btn-bg, var(--v4-control-faint)); color: var(--t1, var(--v4-text-1)); white-space: nowrap; flex: none; }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
</style>
