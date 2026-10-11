<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import ReadLoader from "../../common/ReadLoader.svelte";
  import CompanyLabel from "../../company/CompanyLabel.svelte";
  import ProfileBadges from "../../badges/ProfileBadges.svelte";
  import type { EarnedBadge, ResolvedBadge } from "../../badges/badge-catalog.js";
  /**
   * 340 px bot profile. Follows the Messages profile pane rhythm
   * (MemberProfilePanel): 12px 14px header with a hairline, 13px text,
   * sentence-case labels, a 20px name. Paints from the cached snapshot.
   *
   * This pane owns every bot control: UID with Copy, runtime chip, scheduled
   * jobs, 30-day usage, Pause / Resume, Open session, Edit (each section's
   * Edit opens that tab of the edit sheet) and Stop. Other surfaces link here.
   */
  import {
    PROFILE_PANE_WIDTH,
    metadata,
    profilePhase,
    type BotProfileSnapshot,
  } from "./profile-pane-model.js";

  import type { EditBotTab } from "./profile-pane-model.js";
  import type { Snippet } from "svelte";

  export type BotPaneTab = "profile" | "jobs";

  interface BotUsageSummary {
    status: "loading" | "ready" | "unavailable";
    tokens?: string;
    sessions?: number | null;
    daily?: number[];
    message?: string;
  }

  interface Props {
    snapshot: BotProfileSnapshot | null;
    /** Agent UID; shown with Copy. Empty hides the row. */
    uid?: string | null;
    /** Where the bot runs: Local (this computer) or Cloud (hosted fleet). */
    runtimeKind?: "local" | "cloud" | null;
    usage?: BotUsageSummary | null;
    /** True while the bot is paused (stopped box); the button reads Resume. */
    paused?: boolean;
    busy?: boolean;
    actionError?: string | null;
    /** Earned accomplishment badges; none hides the section. */
    badges?: readonly EarnedBadge[];
    /** Opens a badge's detail view. */
    onbadge?: (badge: ResolvedBadge) => void;
    /** Opens the Badges page. */
    onbadges?: () => void;
    onclose?: () => void;
    onmessage?: () => void;
    onsession?: () => void;
    onedit?: (tab?: EditBotTab) => void;
    onpause?: () => void;
    onresume?: () => void;
    onstop?: () => void;
    /** Profile | Jobs. Tabs show only when a Jobs panel is given. */
    tab?: BotPaneTab;
    ontab?: (tab: BotPaneTab) => void;
    /** Job count beside the Jobs tab; null while unknown. */
    jobsCount?: number | null;
    jobsPanel?: Snippet;
  }

  let {
    snapshot,
    uid = null,
    runtimeKind = null,
    usage = null,
    paused = false,
    busy = false,
    actionError = null,
    badges = [],
    onbadge,
    onbadges,
    onclose,
    onmessage,
    onsession,
    onedit,
    onpause,
    onresume,
    onstop,
    tab = "profile",
    ontab,
    jobsCount = null,
    jobsPanel,
  }: Props = $props();

  const phase = $derived(profilePhase(snapshot?.name));
  void metadata;
  let copied = $state(false);
  const dailyMax = $derived(Math.max(0, ...(usage?.daily ?? [])));

  async function copyUid(): Promise<void> {
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(uid);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch (err) {
      console.warn("[hq-desktop] copy bot UID failed", err);
      copied = false;
    }
  }
</script>

<aside
  class="pane"
  style:width="{PROFILE_PANE_WIDTH}px"
  aria-label={snapshot ? `${snapshot.name} profile` : "Bot profile"}
  data-testid="bot-profile-pane"
  data-phase={phase}
  data-live={snapshot?.live ? "true" : "false"}
>
  <header class="phead">
    {#if jobsPanel}
      <div class="ptabs" role="tablist" aria-label="Bot pane">
        <button type="button" class="ptab" role="tab" aria-selected={tab === "profile"} data-testid="bot-pane-tab-profile" onclick={() => ontab?.("profile")}>Profile</button>
        <button type="button" class="ptab" role="tab" aria-selected={tab === "jobs"} data-testid="bot-pane-tab-jobs" onclick={() => ontab?.("jobs")}>Jobs{#if jobsCount !== null && jobsCount > 0}<span class="count">{jobsCount}</span>{/if}</button>
      </div>
    {:else}
      <span class="pp-title">Profile</span>
    {/if}
    <button type="button" class="icon" data-testid="bot-profile-close" aria-label="Close profile" onclick={() => onclose?.()}><RailIcon name="x" size={14} /></button>
  </header>
  {#if tab === "jobs" && jobsPanel}
    <div class="body" data-testid="bot-pane-jobs-body">{@render jobsPanel()}</div>
  {:else if phase === "shimmer" || !snapshot}
    <div class="body" aria-busy="true">
      <ReadLoader testid="bot-profile-loading" />
    </div>
  {:else}
    <div class="body">
      <div class="top">
        <span class="mark lg" aria-hidden="true">{snapshot.name.slice(0, 1).toUpperCase()}{#if snapshot.live}<i class="ld"></i>{/if}</span>
        <div>
          <div class="nm">{snapshot.name}</div>
          <div class="hd">{snapshot.handle} · {snapshot.email}</div>
          <div class="hd">
            Bot · owned by {snapshot.owner}
            {#if runtimeKind}<span class="chip rt" data-testid="bot-profile-runtime-chip">{runtimeKind === "cloud" ? "Cloud" : "Local"}</span>{/if}
          </div>
        </div>
      </div>
      {#if uid}
        <div class="uid" data-testid="bot-profile-uid">
          <span class="k0">UID</span>
          <span class="v">{uid}</span>
          <button type="button" class="link" data-testid="bot-profile-copy-uid" onclick={() => void copyUid()}><RailIcon name="copy" />{copied ? "Copied" : "Copy"}</button>
        </div>
      {/if}
      <button type="button" class="btn primary" data-testid="bot-profile-message" onclick={() => onmessage?.()}><RailIcon name="send" />Message</button>
      <div class="act">
        <button
          type="button"
          class="btn"
          data-testid="bot-profile-pause"
          disabled={busy}
          onclick={() => (paused ? onresume?.() : onpause?.())}
        ><RailIcon name="stop" />{paused ? "Resume" : "Pause"}</button>
        <button type="button" class="btn" data-testid="bot-profile-session" onclick={() => onsession?.()}><RailIcon name="external" />Open session</button>
        <button type="button" class="btn" data-testid="bot-profile-edit" onclick={() => onedit?.("identity")}><RailIcon name="pencil" />Edit</button>
        <button type="button" class="btn" data-testid="bot-profile-stop" disabled={busy} onclick={() => onstop?.()}><RailIcon name="stop" />Stop</button>
      </div>
      {#if actionError}
        <p class="err" role="alert" data-testid="bot-profile-action-error">{actionError}</p>
      {/if}
      <section class="g">
        <div class="k">Now</div>
        <div class="now">
          <div class="st" class:live={snapshot.live}>
            {snapshot.live ? "Live · working" : snapshot.idleNote}
          </div>
          {snapshot.nowTitle}
          {#if snapshot.nowMeta.length}
            <div class="m">{#each snapshot.nowMeta as bit (bit)}<span>{bit}</span>{/each}</div>
          {/if}
        </div>
      </section>
      <ProfileBadges {badges} onselect={onbadge} onseeall={onbadges} />
      <section class="g">
        <div class="k">Runtime {#if snapshot.runtimeVersion}<span class="count">{snapshot.runtimeVersion}</span>{/if} <button type="button" class="link" data-testid="bot-profile-edit-runtime" onclick={() => onedit?.("runtime")}><RailIcon name="pencil" />Edit</button></div>
        <div class="kv">
          {#each snapshot.runtime as row (row.label)}
            <b>{row.label}</b><span>{row.value}</span>
          {/each}
        </div>
      </section>
      {#if snapshot.companies.length}
        <section class="g">
          <div class="k" data-testid="bot-profile-companies-label">{#if snapshot.companiesScope === "all"}Companies <span class="count">{snapshot.companies.length}</span>{:else}In this company{/if} <button type="button" class="link" data-testid="bot-profile-edit-membership" onclick={() => onedit?.("membership")}><RailIcon name="pencil" />Edit</button></div>
          {#each snapshot.companies as co (co.name)}
            <div class="co" data-testid="bot-profile-company"><CompanyLabel name={co.name} /><span class="r">{co.role}</span></div>
          {/each}
        </section>
      {/if}
      {#if snapshot.capabilities.length}
        <section class="g">
          <div class="k">Capabilities <button type="button" class="link" data-testid="bot-profile-edit-capabilities" onclick={() => onedit?.("capabilities")}><RailIcon name="pencil" />Edit</button></div>
          <div class="chips">{#each snapshot.capabilities as cap (cap)}<span class="chip">{cap}</span>{/each}</div>
        </section>
      {/if}
      {#if snapshot.runs.length}
        <section class="g">
          <div class="k">Recent runs</div>
          {#each snapshot.runs as run (run.id)}
            <div class="run"><span class="mk" class:live={run.state === "live"} class:err={run.state === "failed"}></span><div><div class="t">{run.title}</div><span class="meta">{run.meta}</span></div><span class="trail" class:err={run.state === "failed"}>{run.trailing}</span></div>
          {/each}
        </section>
      {/if}
      {#if snapshot.jobs.length}
        <section class="g">
          <div class="k">Scheduled jobs <span class="count">{snapshot.jobs.length}</span>{#if jobsPanel}<button type="button" class="link" data-testid="bot-profile-open-jobs" onclick={() => ontab?.("jobs")}>Open Jobs</button>{/if}</div>
          {#if !jobsPanel}
            {#each snapshot.jobs as job (job.id)}
              <div class="run"><span class="mk"></span><div><div class="t">{job.title}</div><span class="meta">{job.meta}</span></div><span class="trail">{job.trailing}</span></div>
            {/each}
          {/if}
        </section>
      {/if}
      {#if usage}
        <section class="g" data-testid="bot-profile-usage" data-state={usage.status}>
          <div class="k">Bot · 30d usage</div>
          {#if usage.status === "loading"}
            <ReadLoader testid="bot-profile-usage-loading" />
          {:else if usage.status === "unavailable"}
            <div class="m">{usage.message ?? "Not available yet."}</div>
          {:else}
            <div class="kv">
              <b>Tokens</b><span>{usage.tokens ?? "0"}</span>
              {#if usage.sessions !== null && usage.sessions !== undefined}<b>Sessions</b><span>{usage.sessions}</span>{/if}
            </div>
            {#if usage.daily && usage.daily.length}
              <div class="spark" aria-hidden="true">
                {#each usage.daily as value, i (i)}<i style:height="{dailyMax > 0 ? Math.max(8, Math.round((value / dailyMax) * 100)) : 8}%"></i>{/each}
              </div>
            {/if}
          {/if}
        </section>
      {/if}
      {#if snapshot.grants.length}
        <section class="g">
          <div class="k">Vault access <button type="button" class="link" data-testid="bot-profile-edit-access" onclick={() => onedit?.("access")}><RailIcon name="pencil" />Edit</button></div>
          {#each snapshot.grants as grant (grant.path)}
            <div class="va"><span class="d">{grant.path}</span><span class:w={grant.level.includes("write")}>{grant.level}</span></div>
          {/each}
        </section>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .pane {
    box-sizing: border-box;
    max-width: 100%;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--v4-secondary-sidebar, var(--side-bg));
    color: var(--v4-text-2);
    font: 400 13px/1.45 var(--font-ui, var(--font-sans));
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--v4-rowline, var(--line));
  }
  .pp-title { color: var(--v4-text-1); font-size: 13px; font-weight: 500; }
  /* The tab label lines up with the 20px content edge below the header. */
  .ptabs { display: inline-flex; gap: 2px; margin-left: -2px; }
  .ptab {
    display: inline-flex; align-items: center; gap: 6px;
    height: 24px; padding: 0 8px; border: 0; border-radius: 6px;
    background: transparent; color: var(--v4-text-2); font: inherit; font-weight: 500; cursor: pointer;
  }
  .ptab:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .ptab[aria-selected="true"] { background: var(--sel, var(--v4-control-bg)); color: var(--v4-text-1); }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font-size: 13px;
    cursor: pointer;
  }
  .icon:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .body { min-height: 0; overflow: auto; padding: 24px 20px; display: flex; flex-direction: column; gap: 16px; }
  .top { display: flex; gap: 12px; align-items: center; }
  .mark {
    width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
    background: var(--v4-control-bg); color: var(--v4-text-1); font-size: 13px; flex: none;
  }
  .mark.lg { width: 44px; height: 44px; border-radius: 10px; position: relative; }
  .ld {
    position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border-radius: 50%;
    background: var(--v4-ok); border: 2px solid var(--v4-secondary-sidebar, var(--side-bg));
  }
  .nm { font-size: 20px; line-height: 1.25; font-weight: 500; color: var(--v4-text-1); }
  .hd { color: var(--v4-text-3); margin-top: 2px; }
  .act { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .btn {
    flex: 1 1 0;
    min-width: 0;
    height: var(--hq-btn-h);
    padding: 0 var(--hq-btn-pad-inline);
    border: 1px solid var(--v4-control-border, var(--line2));
    background: transparent;
    color: var(--v4-text-1);
    border-radius: var(--v4-radius-button, 6px);
    font: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .btn.primary {
    flex: none;
    width: 100%;
    height: var(--hq-btn-h);
    border-radius: 8px;
    border-color: transparent;
    background: var(--v4-primary-bg, var(--t1));
    color: var(--v4-primary-fg, var(--v4-bg));
    font-weight: 500;
  }
  .btn.primary:hover { background: var(--v4-primary-bg, var(--t1)); opacity: 0.85; }
  .g { border-top: 1px solid var(--v4-rowline, var(--line)); padding-top: 12px; }
  /* Section labels: the mono caps label style. */
  .k {
    font: 500 10px/1.4 var(--font-mono, "Geist Mono", monospace); letter-spacing: 0.1em; text-transform: uppercase; color: var(--v4-text-3);
    display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
  }
  .count { color: var(--v4-text-3); font-weight: 400; font-variant-numeric: tabular-nums; }
  .link {
    margin-left: auto; padding: 0; border: 0; background: none;
    color: var(--v4-text-2); font: inherit; cursor: pointer;
  }
  /* Text buttons dim on hover; no underline. */
  .link:hover { color: var(--v4-text-3); }
  .now { color: var(--v4-text-1); }
  .st { display: flex; gap: 6px; align-items: center; color: var(--v4-text-2); margin-bottom: 2px; }
  .st.live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--v4-ok); }
  .m { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; color: var(--v4-text-3); }
  .kv { display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; color: var(--v4-text-1); }
  .kv b { font-weight: 400; color: var(--v4-text-3); }
  .co { display: flex; align-items: center; gap: 8px; min-height: 28px; color: var(--v4-text-1); }
  .r { margin-left: auto; color: var(--v4-text-3); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 1px 7px; border-radius: var(--v4-radius-pill, 999px); background: var(--v4-control-bg); color: var(--v4-text-2); }
  .run { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 6px 0; border-bottom: 1px solid var(--v4-rowline, var(--line)); color: var(--v4-text-1); }
  .run:last-child { border-bottom: 0; }
  .mk { width: 6px; height: 6px; border-radius: 50%; background: var(--v4-text-3); margin-top: 7px; }
  .mk.live { background: var(--v4-ok); }
  .mk.err { background: var(--v4-error); }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .trail { color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
  .meta { display: block; }
  .trail.err { color: var(--v4-error); }
  .va { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
  .va .d { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--v4-text-2); font-family: var(--font-mono, "Geist Mono", monospace); }
  .va .w { color: var(--v4-text-1); }
  .uid { display: flex; align-items: center; gap: 8px; color: var(--v4-text-3); }
  .uid .k0 { flex: none; }
  .uid .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--v4-text-2); font-family: var(--font-mono, "Geist Mono", monospace); }
  .chip.rt { margin-left: 6px; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .err { margin: 0; color: var(--v4-error); }
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 28px; margin-top: 8px; }
  .spark i { flex: 1; min-width: 2px; border-radius: 1px; background: var(--v4-control-bg); }
</style>
