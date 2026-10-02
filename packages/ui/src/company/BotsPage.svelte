<script lang="ts">
  import { dismissable } from "../common/dismissable.js";
  /**
   * Company Bots page (console-rail US-027).
   *
   * Local rows come from the shell's already-loaded bot list (the same
   * records BotsSettingsPane reads). Cloud rows use adapter.agents
   * listMobileRoster, the BotsSettingsPane source, refreshed after first
   * paint. Pause calls agents.stop only after confirmation.
   */
  import { onMount } from "svelte";
  import type { LocalBotRow, PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import { cloudBotsFromRoster } from "../settings/cloud-bots.js";
  import {
    BOT_FILTERS,
    JOB_ALERTS,
    emptyJobDraft,
    filterBots,
    metadata,
    pauseAllowed,
    type BotFilter,
    type BotListRow,
    type JobAlert,
    type ScheduledJob,
  } from "./team-bots-pages.js";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    companyUid?: string | null;
    adapter?: PlatformAdapter | null;
    companies?: Workspace[] | null;
    localBots?: ReadonlyArray<LocalBotRow> | null;
    onmessage?: (uid: string) => void;
    onopensession?: (uid: string) => void;
    onsettings?: () => void;
  }

  let {
    companyUid = null,
    adapter = null,
    companies = null,
    localBots = null,
    onmessage,
    onopensession,
    onsettings,
  }: Props = $props();

  let cloud = $state<BotListRow[]>([]);
  let cloudPhase = $state<"shimmer" | "ready">("shimmer");
  let filter = $state<BotFilter>("all");
  let selected = $state<string | null>(null);
  let pauseUid = $state<string | null>(null);
  let paused = $state<Set<string>>(new Set());
  let jobOpen = $state(false);
  let job = $state<ScheduledJob>(emptyJobDraft());
  let jobs = $state<ScheduledJob[]>([]);

  function localRows(): BotListRow[] {
    return (localBots ?? [])
      .filter((bot) => !companyUid || !bot.promotionHold?.companyUid || bot.promotionHold.companyUid === companyUid)
      .map((bot) => ({
        uid: bot.agentUid,
        name: bot.displayName?.trim() || bot.name,
        kind: "local" as const,
        live: bot.state === "running" || bot.online === true || bot.busy === true,
        status: bot.state || "idle",
        detail: bot.runtime,
        canPause: true,
      }));
  }

  const rows = $derived(filterBots([...localRows(), ...cloud], filter));
  const current = $derived(rows.find((row) => row.uid === selected) ?? rows[0] ?? null);
  const empty = $derived(cloudPhase === "ready" && localRows().length === 0 && cloud.length === 0);

  onMount(() => {
    let cancelled = false;
    void (async () => {
      const agents = adapter?.agents;
      if (!agents?.listMobileRoster) {
        cloudPhase = "ready";
        return;
      }
      try {
        const result = await agents.listMobileRoster(companyUid);
        if (cancelled) return;
        if (result.ok) {
          cloud = cloudBotsFromRoster(result.value, { companies }).map((bot) => ({
            uid: bot.uid,
            name: bot.displayName,
            kind: "cloud" as const,
            live: bot.status === "WORKING",
            status: bot.phase || bot.status,
            detail: bot.companyLabel ?? "Cloud",
            canPause: bot.canManage,
          }));
        }
      } finally {
        if (!cancelled) cloudPhase = "ready";
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (current && selected !== current.uid) selected = current.uid;
  });

  async function confirmPause(): Promise<void> {
    const uid = pauseUid;
    pauseUid = null;
    if (!uid || !pauseAllowed(true)) return;
    const agents = adapter?.agents;
    if (agents?.stop) await agents.stop(uid);
    paused = new Set([...paused, uid]);
  }

  function saveJob(): void {
    const next = { ...job, id: job.id || `job-${job.name}` };
    jobs = [next, ...jobs.filter((row) => row.id !== next.id)];
    jobOpen = false;
  }
</script>

<section
  class="bots-page"
  data-testid="bots-page"
  data-scene={empty ? "bots-empty" : "bots"}
  data-scroll-budget={metadata.performanceBudget.scrollDroppedFramesPct}
>
  <div class="toolbar">
    <h1>Bots</h1>
    <div class="tabs" role="tablist">
      {#each BOT_FILTERS as id (id)}
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={filter === id}
          data-testid={`bots-filter-${id}`}
          onclick={() => (filter = id)}
        >{id === "all" ? "All" : id === "local" ? "Local" : id === "cloud" ? "Cloud" : "Live"}</button>
      {/each}
    </div>
    <span class="grow"></span>
    <span class="chip">{rows.length} bots</span>
  </div>

  {#if empty}
    <div class="empty" data-testid="bots-empty">
      <div class="card">
        <strong>New agent</strong>
        <p>A rounded-square mark. Six steps, then a probe. An agent inherits only the access you grant.</p>
      </div>
      <p class="sech">Where an agent can run</p>
      <p class="line"><b>Local</b> <code>hq bot</code> · Free</p>
      <p class="line"><b>Hosted fleet agent</b> HQ Workforce · <code>/new-agent</code></p>
      <p class="line"><b>External</b> <code>hq agent enroll</code> · Paid plans</p>
    </div>
  {:else}
    <div class="split">
      <div class="roster">
        {#if cloudPhase === "shimmer" && rows.length === 0}
          <div class="shimmer" data-testid="bots-shimmer" aria-hidden="true"></div>
        {/if}
        {#each rows as row (row.uid)}
          <button
            type="button"
            class="bot-row"
            aria-current={current?.uid === row.uid}
            onclick={() => (selected = row.uid)}
          >
            <span class="sq" aria-hidden="true">⌁</span>
            <span class="nm">{row.name}</span>
            <span class="kind">{row.kind}</span>
            <span class="detail">{row.detail}</span>
            <span class:live={row.live && !paused.has(row.uid)} class="state">
              {paused.has(row.uid) ? "paused" : row.live ? "live" : row.status}
            </span>
          </button>
        {/each}
      </div>
      {#if current}
        <aside class="inspector" data-testid="bot-inspector">
          <header class="head">
            <span class="sq lg" aria-hidden="true">⌁</span>
            <h2>{current.name}</h2>
          </header>
          <div class="kv">
            <b>Kind</b><span>{current.kind}</span>
            <b>Status</b><span>{paused.has(current.uid) ? "paused" : current.status}</span>
            <b>Detail</b><span>{current.detail}</span>
          </div>
          <div class="sech">Scheduled jobs <span class="count">{jobs.length}</span></div>
          {#each jobs as item (item.id)}
            <div class="run">
              <span>{item.name}</span>
              <span class="em">{item.cadence} · {item.alert === "dm" ? "DM" : "No alert"}</span>
              <button type="button" class="btn" onclick={() => { job = { ...item }; jobOpen = true; }}>Edit</button>
            </div>
          {/each}
          <button
            type="button"
            class="btn"
            data-testid="edit-job"
            onclick={() => { job = emptyJobDraft("New job"); jobOpen = true; }}
          >Edit job</button>
          <div class="act">
            <button type="button" class="btn primary" data-testid="bot-message" onclick={() => onmessage?.(current.uid)}>Message</button>
            <button type="button" class="btn" data-testid="bot-session" onclick={() => onopensession?.(current.uid)}>Open session</button>
            <button type="button" class="btn" data-testid="bot-settings" onclick={() => onsettings?.()}>Settings</button>
            <button
              type="button"
              class="btn"
              data-testid="bot-pause"
              disabled={!current.canPause || paused.has(current.uid)}
              onclick={() => (pauseUid = current.uid)}
            >Pause</button>
          </div>
        </aside>
      {/if}
    </div>
  {/if}

  {#if jobOpen}
    <div class="scrim" data-testid="edit-job-sheet" data-scene="edit-job">
      <div class="sheet" role="dialog" aria-label="Edit job" use:dismissable={{ onclose: () => (jobOpen = false), outside: true }}>
        <header class="sh">
          Edit job
          <button type="button" class="icon" aria-label="Close" onclick={() => (jobOpen = false)}>✕</button>
        </header>
        <div class="fr">
          <label for="job-name">Name</label>
          <input id="job-name" class="fld" bind:value={job.name} />
        </div>
        <div class="fr">
          <label for="job-cadence">Cadence</label>
          <input id="job-cadence" class="fld" bind:value={job.cadence} />
        </div>
        <div class="fr">
          <span>Alerts</span>
          <div class="seg">
            {#each JOB_ALERTS as alert (alert)}
              <button
                type="button"
                class="tab"
                aria-selected={job.alert === alert}
                onclick={() => (job.alert = alert as JobAlert)}
              >{alert === "dm" ? "DM" : "None"}</button>
            {/each}
          </div>
        </div>
        <footer class="sf">
          <span class="grow"></span>
          <button type="button" class="btn" onclick={() => (jobOpen = false)}>Cancel</button>
          <button type="button" class="btn primary" onclick={saveJob}>Save</button>
        </footer>
      </div>
    </div>
  {/if}
</section>

<ConfirmDialog
  open={pauseUid != null}
  title="Pause this bot?"
  message="The bot stops taking new work until you resume it from Settings."
  confirmLabel="Pause"
  oncancel={() => (pauseUid = null)}
  onconfirm={() => void confirmPause()}
/>

<style>
  .bots-page {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--v4-text-1);
  }
  .toolbar, .head, .act, .sh, .sf { display: flex; align-items: center; gap: 8px; }
  .toolbar, .sh, .sf { padding: 0 16px; height: 52px; }
  .toolbar, .sh { border-bottom: 1px solid var(--v4-hairline); }
  .sf { border-top: 1px solid var(--v4-hairline); }
  h1, h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .grow { flex: 1; }
  .tabs, .seg { display: inline-flex; gap: 2px; }
  .tab, .btn, .icon {
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    padding: 3px 8px;
  }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .btn { border: 1px solid var(--v4-control-border); background: var(--v4-control-faint); color: var(--v4-text-1); }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .btn:disabled { opacity: 0.5; }
  .chip, .em, .sech, .kind, .detail { color: var(--v4-text-3); font-size: 12px; }
  .sech {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 12px 0 6px;
  }
  .split { display: grid; grid-template-columns: 1fr 340px; min-height: 0; flex: 1; }
  .roster, .inspector { min-height: 0; overflow: auto; padding: 12px 16px 24px; }
  .inspector { border-left: 1px solid var(--v4-hairline); }
  .bot-row {
    display: grid;
    grid-template-columns: 26px 1fr auto auto auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 8px;
    border: 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: 13px;
  }
  .bot-row[aria-current="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .sq {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
  }
  .sq.lg { width: 34px; height: 34px; border-radius: 9px; }
  .nm { color: var(--v4-text-1); font-weight: 500; }
  .state.live { color: var(--v4-ok); }
  .kv { display: grid; grid-template-columns: 72px 1fr; gap: 4px 10px; font-size: 12px; color: var(--v4-text-2); }
  .kv b { font-weight: 500; color: var(--v4-text-3); }
  .run { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--v4-rowline); font-size: 12px; }
  .empty { max-width: 560px; margin: 24px auto; display: flex; flex-direction: column; gap: 12px; }
  .card {
    padding: 16px;
    border: 1px dashed var(--v4-control-border);
    border-radius: var(--v4-radius-card);
    background: var(--v4-control-faint);
  }
  .line { margin: 0; padding: 10px 0; border-top: 1px solid var(--v4-rowline); font-size: 12px; color: var(--v4-text-2); }
  .line code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
  .shimmer { height: 72px; border-radius: 6px; background: var(--v4-control-faint); }
  .scrim { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); z-index: 20; }
  .sheet {
    width: 480px;
    max-width: calc(100% - 32px);
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover);
  }
  .icon { margin-left: auto; }
  .fr { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--v4-rowline); }
  .fld {
    width: 100%;
    box-sizing: border-box;
    min-height: 28px;
    border-radius: 6px;
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    padding: 4px 8px;
  }
  .act { margin-top: 12px; flex-wrap: wrap; }
</style>
