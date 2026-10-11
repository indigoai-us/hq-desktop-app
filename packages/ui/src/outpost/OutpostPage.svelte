<script lang="ts">
  import "../common/inline-banner.css";
  import RailIcon from "../common/button/RailIcon.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Personal Outpost (US-034). OWNER-R19: a status view; managing the
   * Outpost (terminal, updates, restarts, jobs) happens in the web console,
   * which "Open console" opens. First frame is the cache. Refresh runs after paint, then every 60 s while
   * visible; relative times re-render every 30 s from absolute timestamps
   * (QA-069). A failed refresh keeps the cache and says so in the header.
   * An unreachable host shows one state, "Unreachable since <date>", and Retry now.
   */
  import { untrack } from "svelte";
  import { startNowTicker } from "../common/now-ticker.js";
  import { startVisibleInterval } from "../common/visible-interval.js";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/chat-tokens.css";
  import {
    alertLabel,
    filterJobs,
    filterRuns,
    freshnessLabel,
    lastReportCopy,
    lastResultLabel,
    metadata,
    nextRunLabel,
    OUTPOST_REFRESH_MS,
    runWhenLabel,
    readOutpostCache,
    writeOutpostCache,
    type OutpostCache,
    type OutpostRefresher,
    type OutpostTab,
  } from "./outpost-model.js";
  import { outpostFilterLabel } from "./outpost-model.js";
  import { createOutpostRefresher, noOutpost, OUTPOST_SETUP_URL, type OutpostReadApi } from "./outpost-live.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";

  /** The web console's Outpost page; it has no per-outpost route. */
  export const OUTPOST_CONSOLE_URL = `${HQ_CONSOLE_BASE}/personal/outpost`;

  export { metadata };

  interface Props {
    /** Reads live state from the Outpost. Wins over `api` (tests). */
    refresh?: OutpostRefresher;
    /** The desktop hq-pro client; the page reads the user's Outpost through it. */
    api?: OutpostReadApi | null;
    openExternal?: (url: string) => void;
    /**
     * RELEASE-001 gate. False keeps the status card and host settings and
     * hides scheduled jobs, job editing, run history and logs.
     */
    full?: boolean;
  }

  let { refresh, api = null, openExternal, full = true }: Props = $props();

  // First frame is the cache from the last real read, or an unknown state.
  // Nothing here is sample data: rows only come from hq-pro.
  let data = $state<OutpostCache>(readOutpostCache("personal") ?? { ...noOutpost(null), provisioned: null });
  let tab = $state<OutpostTab>("overview");
  let jobFilter = $state<"all" | "active" | "paused" | "failing">("all");
  let runFilter = $state<"all" | "ok" | "failed" | "running">("all");
  let copied = $state(false);

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
    // BLANK-3: no timer ends a pending read. One read at a time: a background
    // refresh skips while a read is still out; Try again starts a fresh one.
    let inflight = false;
    // The visibility gate only skips background refreshes. The first read always
    // runs: a window macOS reports hidden (occluded, behind another app) must
    // still leave "Reading your Outpost…" (QA-084).
    const run = async (background = false): Promise<void> => {
      if (background && typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (background && inflight) return;
      inflight = true;
      try {
        const next = await read();
        if (!live) return;
        const merged = { ...next, fetchedAt: next.fetchedAt ?? new Date().toISOString() };
        writeOutpostCache("personal", merged);
        data = merged;
        refreshFailed = false;
      } catch (err) {
        console.error("[outpost] refresh failed", err);
        if (live) refreshFailed = true;
      } finally {
        inflight = false;
        if (live) now = Date.now();
      }
    };
    void run();
    retry = () => void run();
    // Paused while hidden; refreshes at once when the window is shown.
    const stopRefresh = startVisibleInterval(() => void run(true), OUTPOST_REFRESH_MS);
    const stopTick = startNowTicker((t) => (now = t));
    return () => {
      live = false;
      stopRefresh();
      stopTick();
    };
  });

  let retry = $state<() => void>(() => {});

  const lastReport = $derived(lastReportCopy(data.host.lastHeartbeatIso, now));
  const freshness = $derived(freshnessLabel(data.fetchedAt, refreshFailed, now));

  const jobs = $derived(filterJobs(data.jobs, jobFilter));
  const runs = $derived(filterRuns(data.runs, runFilter));
  const provisioned = $derived(data.provisioned === true);
  const offline = $derived(!provisioned || data.unreachable || !data.host.online);


  // One state (OWNER-R19): the instance line never repeats a running/stopped
  // word next to the reachability state.
  const sizeLine = $derived(
    data.host.instance
      .split(" · ")
      .filter((part) => !/^(running|pending|stopped|stopping|ready|provisioning|terminated)$/i.test(part.trim()))
      .join(" · "),
  );
  // A raw instance id is never the title: show the name, else "Outpost" and the region.
  const rawId = $derived(/^outpost-[0-9a-f-]{8,}$/i.test(data.host.name.trim()) ? data.host.name.trim() : "");
  const title = $derived(rawId || !data.host.name.trim() ? ["Outpost", data.host.region].filter(Boolean).join(" · ") : data.host.name);
  const since = $derived(
    data.host.lastHeartbeatIso && !Number.isNaN(Date.parse(data.host.lastHeartbeatIso))
      ? new Date(data.host.lastHeartbeatIso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "",
  );
  const stateLabel = $derived(offline ? (since ? `Unreachable since ${since}` : "Unreachable") : "Online");
  const tabs = $derived<[OutpostTab, string][]>(
    full ? [["overview", "Overview"], ["jobs", "Scheduled jobs"], ["runs", "Runs"]] : [["overview", "Overview"]],
  );

  function openConsole(): void {
    openExternal?.(OUTPOST_CONSOLE_URL);
  }

  async function copyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(rawId);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (err) {
      console.error("[outpost] copy id failed", err);
    }
  }
</script>

<div class="page" class:single={tabs.length === 1} data-testid="outpost-page" data-tab={tab} data-offline={offline ? "true" : "false"}>
  {#if tabs.length > 1}
  <aside class="pane" aria-label="Outpost">
    <div class="pane-head"><span class="status" data-testid="outpost-pane-host" title={provisioned ? `${title} · ${stateLabel}` : undefined}><span class="dot" class:live={!offline} class:err={offline}></span><span class="label">{provisioned ? title : "Outpost"}</span></span></div>
    <nav>
      {#each tabs as item (item[0])}
        <button type="button" class:on={tab === item[0]} aria-current={tab === item[0] ? "true" : undefined} onclick={() => (tab = item[0])}><span class="label">{item[1]}</span></button>
      {/each}
    </nav>
  </aside>
  {/if}
  <main>
    <header class="toolbar">
      <h1 data-testid="outpost-title">{tab === "overview" ? (provisioned ? title : "Outpost") : tab === "jobs" ? "Scheduled jobs" : "Runs"}</h1>
      {#if provisioned}
        <span class="meta-line" data-meta-line data-testid="outpost-online"><span class="meta-dot dot" class:live={!offline} class:err={offline}></span>{stateLabel}</span>
      {/if}
      <span class="meta-line" data-meta-line class:err={refreshFailed} data-testid="outpost-freshness">{freshness}</span>
      <span class="grow"></span>
      <RailButton icon="external" variant="primary" type="button" data-testid="outpost-open-console" onclick={openConsole}>Open console</RailButton>
    </header>

    {#if data.provisioned === false}
      <div class="empty" data-testid="outpost-empty">
        <span class="nm">No Outpost yet</span>
        <span class="sub">An Outpost is your always-on machine in the cloud for scheduled jobs.</span>
        <RailButton icon="external" variant="primary" type="button" data-testid="outpost-setup" onclick={() => openExternal?.(OUTPOST_SETUP_URL)}>Set one up</RailButton>
      </div>
    {:else if data.provisioned === null && refreshFailed}
      <div class="empty" role="alert" data-testid="outpost-load-error">
        <span class="nm">Couldn't read your Outpost</span>
        <RailButton icon="refresh" type="button" data-testid="outpost-try-again" onclick={() => retry()}>Try again</RailButton>
      </div>
    {:else if data.provisioned === null}
      <div class="empty sub" data-testid="outpost-loading"><ReadLoader testid="outpost-loader" onretry={() => retry()} /></div>
    {:else if offline}
      <div class="inline-banner banner" role="alert" data-testid="outpost-offline-banner" title={lastReport.title}>
        <span class="inline-banner-text">{lastReport.text}</span>
        <RailButton icon="refresh" type="button" onclick={() => retry()}>Retry now</RailButton>
      </div>
    {/if}

    {#if provisioned && tab === "overview"}
      <section class="facts" data-testid="outpost-facts">
        {#if data.host.region || sizeLine}<p class="sub" data-testid="outpost-host">{[data.host.region, sizeLine].filter(Boolean).join(" · ")}</p>{/if}
        {#if data.host.diskUsed}<p class="sub">Disk {data.host.diskUsed} used of {data.host.diskTotal}</p>{/if}
        {#if rawId}
          <p class="sub id-line" data-testid="outpost-id"><span class="mono">{rawId}</span>
            <button type="button" class="copy" data-testid="outpost-copy-id" aria-label="Copy Outpost id" onclick={() => void copyId()}><RailIcon name="copy" />{copied ? "Copied" : "Copy"}</button>
          </p>
        {/if}
      </section>
    {/if}

    {#if provisioned && full}
    {#if tab === "overview" || tab === "jobs"}
      <section>
        <div class="tabs">
          {#each ["all", "active", "paused", "failing"] as name (name)}
            <button type="button" class:on={jobFilter === name} onclick={() => (jobFilter = name as typeof jobFilter)}>{outpostFilterLabel(name)}</button>
          {/each}
        </div>
        <div class="jrow hd"><span>Job</span><span>Cadence</span><span>Next run</span><span>Last result</span><span>Alerts</span></div>
        {#if data.jobsUnavailable}
          {@render jobsError("outpost-jobs-error", "Couldn't load scheduled jobs")}
        {:else if data.jobs.length === 0}
          <p class="sub" data-testid="outpost-no-jobs">No scheduled jobs</p>
        {/if}
        {#each jobs as job (job.id)}
          <div class="jrow" class:paused={job.paused}>
            <span class="cell"><span class="nm">{job.name}</span><small>{job.detail}</small></span>
            <span>{job.cadenceLabel}</span>
            <span data-testid="job-next-run">{nextRunLabel(job, now)}</span>
            <span class="st result {job.status}" data-testid="job-last-result" title={lastResultLabel(job, now)}>{lastResultLabel(job, now)}</span>
            <span data-testid="job-alert">{alertLabel(job.alert, job.alertWhen)}</span>
          </div>
        {/each}
      </section>
    {/if}

    {#if tab === "overview" || tab === "runs"}
      <section data-testid="outpost-runs">
        <div class="tabs">
          {#each ["all", "ok", "failed", "running"] as name (name)}
            <button type="button" class:on={runFilter === name} onclick={() => (runFilter = name as typeof runFilter)}>{outpostFilterLabel(name)}</button>
          {/each}
        </div>
        {#if data.jobsUnavailable}
          {#if tab === "runs"}{@render jobsError("outpost-runs-error", "Couldn't load runs")}{/if}
        {:else if data.runs.length === 0}
          <p class="sub" data-testid="outpost-no-runs">No runs yet</p>
        {/if}
        {#each runs as run (run.id)}
          <div class="run"><span class="nm">{run.job}</span><span class="cell sub" data-testid="run-when">{runWhenLabel(run, now)} · {run.detail}</span><span class="st {run.status}"><span class="dot" class:live={run.status === "running"} class:err={run.status === "failed"}></span>{outpostFilterLabel(run.status)}</span></div>
        {/each}
      </section>
    {/if}
    {/if}
  </main>
</div>

{#snippet jobsError(testid: string, title: string)}
  <div class="sub section-error" role="alert" data-testid={testid}>
    <span>{title}</span>
    <RailButton icon="refresh" type="button" onclick={() => retry()}>Try again</RailButton>
  </div>
{/snippet}

<style>
  .section-error { display: flex; align-items: center; gap: 8px; }
  .page.single { grid-template-columns: minmax(0, 1fr); }
  .facts p { margin: 0 0 4px; }
  .id-line { display: flex; align-items: center; gap: 8px; }
  .copy { background: transparent; border: 0; color: var(--t2, var(--v4-text-2)); padding: 0 4px; border-radius: 4px; }
  .copy:hover { background: var(--hover, var(--v4-hover)); }
  /* Console-rail chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px Geist everywhere else, 31px rows, status as dot plus
     text, mono only for the fingerprint, cron, commands and log lines. */
  .page { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; min-height: 0; color: var(--t1, var(--v4-text-1)); background: var(--v4-ground); font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif); position: relative; }
  /* QA-096: the sidebar is a fixed 260px column; a long host name must truncate
     inside it, never paint over the main header. */
  .pane { border-right: 1px solid var(--line, var(--v4-hairline)); padding: 12px 14px; min-width: 0; overflow: hidden; }
  .pane-head { height: 31px; display: flex; align-items: center; min-width: 0; padding: 0 8px; color: var(--t2, var(--v4-text-2)); }
  .pane-head .status { min-width: 0; max-width: 100%; }
  .pane .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav button { display: flex; align-items: center; min-width: 0; }
  h1 { font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); margin: 0 4px 0 0; }
  nav { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; }
  button { font: inherit; font-size: 13px; cursor: pointer; }
  nav button, .tabs button { background: transparent; color: var(--t2, var(--v4-text-2)); border: 0; border-radius: 6px; text-align: left; padding: 0 8px; height: 26px; }
  nav button { height: 31px; padding: 7px 8px; border-radius: 8px; }
  nav button.on, .tabs button.on { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  nav button:hover, .tabs button:hover { background: var(--hover, var(--v4-hover)); }
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
  .banner { margin: 0 0 12px; }
  .tabs { display: flex; align-items: center; gap: 2px; margin-bottom: 4px; }
  .tabs :global([data-rail-btn]) { margin-left: auto; }
  .jrow { display: grid; grid-template-columns: minmax(0, 1.8fr) 120px 100px minmax(0, 1fr) 90px; gap: 8px; align-items: center; height: 31px; box-sizing: border-box; padding: 0 8px; border-radius: 8px; }
  .jrow > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* QA-052: at narrow widths the last result wraps instead of clipping the
     time, duration, and failure streak. The row grows to fit. */
  .jrow:not(.hd) { height: auto; min-height: 31px; padding-block: 6px; }
  .jrow > .st.result { display: block; white-space: normal; overflow: visible; overflow-wrap: anywhere; }
  .jrow.paused { color: var(--t3, var(--v4-text-3)); }
  .jrow.hd { color: var(--t3, var(--v4-text-3)); cursor: default; }
  .run { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto; gap: 8px; align-items: center; height: 31px; padding: 0 8px; }
  .run > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button:disabled { opacity: 0.45; cursor: default; }
</style>
