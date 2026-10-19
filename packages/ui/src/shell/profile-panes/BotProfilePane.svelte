<script lang="ts">
  import BotChannelsPanel from "./BotChannelsPanel.svelte";
  import { channelRows } from "./bot-channels.js";
  import BotFeatureIntro from "./BotFeatureIntro.svelte";
  import NewBotOrbIcon from "../../chat/create-bot/NewBotOrbIcon.svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import ReadLoader from "../../common/ReadLoader.svelte";
  import CompanyLabel from "../../company/CompanyLabel.svelte";
  import ProfileBadges from "../../badges/ProfileBadges.svelte";
  import type { EarnedBadge, ResolvedBadge } from "../../badges/badge-catalog.js";
  /**
   * Responsive bot management workspace. Follows the Messages profile pane rhythm
   * (MemberProfilePanel): 12px 14px header with a hairline, 13px text,
   * sentence-case labels, a 20px name. Paints from the cached snapshot.
   *
   * The details section preserves existing bot controls: UID with Copy, runtime chip, scheduled
   * jobs, 30-day usage, Pause / Resume and Stop. Profile fields are edited
   * inline; chat remains in the adjacent conversation.
   */
  import {
    metadata,
    profilePhase,
    type BotProfileSnapshot,
  } from "./profile-pane-model.js";

  import type { EditBotTab } from "./profile-pane-model.js";
  import type { Snippet } from "svelte";

  export type BotPaneTab = "channels" | "routines" | "apps" | "brain";
  const tabs = ["channels", "routines", "apps", "brain"] as const;
  const tabIcons = { channels: "send", routines: "arrows-clockwise", apps: "plug", brain: "sliders" } as const;
  const labels = { channels: "Channels", routines: "Routines", apps: "Apps", brain: "Brain" };

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
    /** Controlled tab; standalone previews manage their own selection. */
    tab?: BotPaneTab;
    ontab?: (tab: BotPaneTab) => void;
    /** Routine count; null while unknown. */
    jobsCount?: number | null;
    jobsPanel?: Snippet;
    detailsEditor?: Snippet;
    channelsPanel?: Snippet;
    appsPanel?: Snippet;
    brainPanel?: Snippet;
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
    onpause,
    onresume,
    onstop,
    tab = $bindable("channels"),
    ontab,
    jobsCount = null,
    jobsPanel,
    detailsEditor,
    channelsPanel,
    appsPanel,
    brainPanel,
  }: Props = $props();

  const paneId = $props.id();
  let detailsOpen = $state(false);
  let detailsVisited = $state(false);
  const stableUid = $derived(uid);
  $effect(() => { void stableUid; detailsOpen = false; detailsVisited = false; });
  function selectTab(next: BotPaneTab): void {
    detailsOpen = false;
    tab = next;
    ontab?.(next);
  }
  function navigateTabs(event: KeyboardEvent): void {
    const index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next]);
    const list = (event.currentTarget as HTMLElement).parentElement;
    list?.querySelector<HTMLButtonElement>(`[data-tab="${tabs[next]}"]`)?.focus();
  }

  const brainRuntime = $derived((snapshot?.runtime ?? []).filter(row => /^(provider|model)$/i.test(row.label)));
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

<aside class="pane" aria-label={snapshot ? `${snapshot.name} bot management` : "Bot management"}
  data-testid="bot-profile-pane" data-phase={phase} data-live={snapshot?.live ? "true" : "false"}>
  <header class="phead">
    <span class="pp-title"><span class="hq-mark">HQ</span> / <span>Manage bot</span></span>
    <div class="header-actions">
      {#if snapshot && phase !== "shimmer"}
        <button type="button" class="details-button" aria-expanded={detailsOpen} aria-controls="{paneId}-details" onclick={() => { detailsOpen = !detailsOpen; detailsVisited = true; }}><RailIcon name="sliders" />Bot details</button>
      {/if}
    <button type="button" class="icon" data-testid="bot-profile-close" aria-label="Close bot management" onclick={() => onclose?.()}><RailIcon name="x" /></button>
    </div>
  </header>
  {#if snapshot && phase !== "shimmer"}
    <div class="identity">
      <div class="top">
        <span class="mark lg" aria-hidden="true"><span class="orb"><NewBotOrbIcon kind={runtimeKind === "cloud" ? "cloud" : "local"} size={40} /></span>{#if snapshot.live}<i class="ld"></i>{/if}</span>
        <div>
          <div class="nm">{snapshot.name}</div>
          <div class="hd">{snapshot.handle}
            {#if runtimeKind}<span class="chip rt" data-testid="bot-profile-runtime-chip">{runtimeKind === "cloud" ? "Cloud" : "Local"}</span>{/if}
          </div>
        </div>
      </div>
      <div class="header-meta">
        <span class="st" class:live={snapshot.live}>{snapshot.live ? "Live · working" : snapshot.idleNote}</span>
        {#each snapshot.companies as company (company.name)}<CompanyLabel name={company.name} />{/each}
      </div>

    </div>
  {/if}
  <div class="ptabs" role="tablist" aria-label="Bot management">
    {#each tabs as item}
      <button type="button" class="ptab" role="tab" id="{paneId}-tab-{item}" aria-controls="{paneId}-panel-{item}"
        aria-selected={tab === item} tabindex={tab === item ? 0 : -1} data-tab={item}
        data-testid="bot-pane-tab-{item}" onclick={() => selectTab(item)} onkeydown={navigateTabs}>
        <span class="tab-icon"><RailIcon name={tabIcons[item]} /></span>{labels[item]}{#if item === "routines" && jobsCount !== null && jobsCount > 0}<span class="count">{jobsCount}</span>{/if}
      </button>
    {/each}
  </div>
  <div class="body">
    {#if phase === "shimmer" || !snapshot}
      <div aria-busy="true"><ReadLoader testid="bot-profile-loading" /></div>
    {:else}
      <section class="details" id="{paneId}-details" hidden={!detailsOpen} aria-label="Bot details">
        <div class="section-heading"><h2>Bot details</h2></div>
        {#if detailsVisited && detailsEditor}{@render detailsEditor()}{/if}
        <details class="operational-details"><summary>Activity, runtime & access</summary><div class="operational-body">
        <div class="kv"><b>Owner</b><span>{snapshot.owner}</span><b>Email</b><span>{snapshot.email}</span></div>
      {#if uid}
        <div class="uid" data-testid="bot-profile-uid">
          <span class="k0">UID</span>
          <span class="v">{uid}</span>
          <button type="button" class="link" data-testid="bot-profile-copy-uid" onclick={() => void copyUid()}><RailIcon name="copy" />{copied ? "Copied" : "Copy"}</button>
        </div>
      {/if}
        <div class="act">
          <button type="button" class="btn" data-testid="bot-profile-pause" disabled={busy} onclick={() => paused ? onresume?.() : onpause?.()}><RailIcon name="stop" />{paused ? "Resume" : "Pause"}</button>
          <button type="button" class="btn" data-testid="bot-profile-stop" disabled={busy} onclick={() => onstop?.()}><RailIcon name="stop" />Stop</button>
        </div>
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
        <div class="k">Runtime {#if snapshot.runtimeVersion}<span class="count">{snapshot.runtimeVersion}</span>{/if}</div>
        <div class="kv">
          {#each snapshot.runtime as row (row.label)}
            <b>{row.label}</b><span>{row.value}</span>
          {/each}
        </div>
      </section>
      {#if snapshot.companies.length}
        <section class="g">
          <div class="k" data-testid="bot-profile-companies-label">{#if snapshot.companiesScope === "all"}Companies <span class="count">{snapshot.companies.length}</span>{:else}In this company{/if}</div>
          {#each snapshot.companies as co (co.name)}
            <div class="co" data-testid="bot-profile-company"><CompanyLabel name={co.name} /><span class="r">{co.role}</span></div>
          {/each}
        </section>
      {/if}
      {#if snapshot.capabilities.length}
        <section class="g">
          <div class="k">Capabilities</div>
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
          <div class="k">Scheduled jobs <span class="count">{snapshot.jobs.length}</span>{#if jobsPanel}<button type="button" class="link" data-testid="bot-profile-open-jobs" onclick={() => selectTab("routines")}>Open routines</button>{/if}</div>
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
          <div class="k">Vault access</div>
          {#each snapshot.grants as grant (grant.path)}
            <div class="va"><span class="d">{grant.path}</span><span class:w={grant.level.includes("write")}>{grant.level}</span></div>
          {/each}
        </section>
      {/if}
        </div></details>
      </section>
      {#if actionError}<p class="err" role="alert" data-testid="bot-profile-action-error">{actionError}</p>{/if}
      <div role="tabpanel" hidden={detailsOpen} id="{paneId}-panel-{tab}" aria-labelledby="{paneId}-tab-{tab}" tabindex="0" class="panel">
        {#if tab === "channels"}
          {#if channelsPanel}{@render channelsPanel()}{:else}<BotChannelsPanel rows={channelRows(null, null, false)} />{/if}
        {:else if tab === "routines"}
          {#if jobsPanel}<div data-testid="bot-pane-jobs-body">{@render jobsPanel()}</div>
          {:else}<BotFeatureIntro kind="routines" />{/if}
        {:else if tab === "apps"}
          {#if appsPanel}{@render appsPanel()}{:else}<BotFeatureIntro kind="apps" />{/if}
        {:else}
          {#if brainPanel}{@render brainPanel()}{:else}
          {#if brainRuntime.length}<div class="brain-summary"><h3>Current runtime</h3><div class="kv">{#each brainRuntime as row (row.label)}<b>{row.label}</b><span>{row.value}</span>{/each}</div></div>{/if}
          <BotFeatureIntro kind="brain" />
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .pane {
    box-sizing: border-box;
    max-width: 100%;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    width: 680px;
    background: var(--v4-secondary-sidebar, var(--side-bg));
    color: var(--v4-text-2);
    font: 400 13px/1.45 var(--font-ui, var(--font-sans));
  }
  .pane[data-phase="shimmer"] { grid-template-rows: auto auto minmax(0, 1fr); }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--v4-rowline, var(--line));
  }
  .pp-title { display: flex; align-items: center; gap: 10px; color: var(--v4-text-1); font-size: 13px; font-weight: 500; }
  .hq-mark { font-weight: 500; letter-spacing: -0.05em; color: var(--v4-text-1); }
  /* The tab label lines up with the 20px content edge below the header. */
  .ptabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 4px; margin: 0 16px; border: 1px solid var(--v4-rowline, var(--line)); border-radius: 14px; background: color-mix(in srgb, var(--v4-text-1) 3%, transparent); }
  .ptab {
    display: inline-flex; align-items: center; gap: 6px;
    justify-content: center; min-width: 0; height: 34px; padding: 0 6px; border: 0; border-radius: 10px;
    background: transparent; color: var(--v4-text-2); font: inherit; font-weight: 500; cursor: pointer;
  }
  .ptab:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .ptab[aria-selected="true"] { background: color-mix(in srgb, var(--v4-text-1) 10%, transparent); color: var(--v4-text-1); box-shadow: 0 1px 3px rgb(0 0 0 / .08); }
  .tab-icon { display: inline-flex; opacity: .65; }
  .ptab { transition: background 160ms ease, color 160ms ease; }
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
  .identity { padding: 16px; display: grid; gap: 8px; min-width: 0; }
  .identity .top > div { min-width: 0; }
  .nm, .hd { overflow-wrap: anywhere; }
  .header-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  .details-button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--v4-text-2); font: inherit; cursor: pointer; }
  .details-button:hover, .details-button[aria-expanded="true"] { background: var(--v4-hover); }
  .operational-details summary { cursor: pointer; color: var(--v4-text-2); padding: 10px 0; }
  .operational-body { display: grid; gap: 16px; padding-top: 12px; }
  .panel { min-width: 0; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2, h3 { margin: 0; font-size: 13px; font-weight: 500; color: var(--v4-text-1); }
  .section-heading h2 { font-size: 20px; font-weight: 400; }
  .details .section-heading h2 { font-size: 13px; font-weight: 500; }
  .brain-summary { padding: 20px; border: 1px solid var(--v4-rowline, var(--line)); border-radius: 12px; background: var(--v4-control-bg); }
  .brain-summary { margin-bottom: 12px; }
  .brain-summary h3 { margin-bottom: 12px; }
  .details:not([hidden]) { display: grid; gap: 16px; padding-bottom: 20px; border-bottom: 1px solid var(--v4-rowline, var(--line)); }
  .details[hidden] { display: none; }
  button:focus-visible, .panel:focus-visible { outline: 2px solid var(--v4-text-2); outline-offset: 2px; }
  @media (max-width: 480px) { .ptabs { margin-inline: 12px; gap: 0; } .ptab .count { display: none; } .identity { padding: 16px 12px; } .brain-summary { padding: 20px 16px; } .tab-icon { display: none; } }
  .body { min-height: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
  .top { display: flex; gap: 12px; align-items: center; }
  .mark {
    width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
    background: var(--v4-control-bg); color: var(--v4-text-1); font-size: 13px; flex: none;
  }
  .mark.lg { width: 40px; height: 40px; border-radius: 50%; position: relative; background: none; }
  .orb { display: flex; filter: grayscale(1); }
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
  @media (prefers-reduced-motion: reduce) { .ptab { transition: none; } }
  .btn:hover:not(:disabled) { background: var(--hover, var(--v4-hover)); }
  .g { border-top: 1px solid var(--v4-rowline, var(--line)); padding-top: 12px; }
  .k {
    color: var(--v4-text-2);
    font-weight: 500;
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  }
  .count { color: var(--v4-text-3); font-weight: 400; font-variant-numeric: tabular-nums; }
  .link {
    margin-left: auto; padding: 0; border: 0; background: none;
    color: var(--v4-text-3); font: inherit; font-weight: 400; cursor: pointer;
  }
  .link:hover { color: var(--v4-text-1); }
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
