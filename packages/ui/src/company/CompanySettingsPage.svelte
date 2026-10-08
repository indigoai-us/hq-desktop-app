<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Company settings (console-rail US-030).
   * General, Brand, Groups, Grants, HQ Workforce, and Billing.
   * Cached snapshot paints on the first frame. Upgrade opens Stripe checkout.
   * Manage payment opens the Stripe portal. Delete group asks first.
   */
  import {
    GRANT_FILTERS,
    emptySnapshot,
    expiringGrantCount,
    filterGrants,
    grantFilterLabel,
    grantLevelLabel,
    metadata,
    readSettingsCache,
    stripeDestination,
    writeSettingsCache,
    type GrantFilter,
    type SettingsSnapshot,
    type SettingsTab,
  } from "./company-settings.js";
  import type { CompanyApi, FilesApi, MessagingApi } from "@hq/platform";
  import ReadLoader from "../common/ReadLoader.svelte";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import { pageRows } from "../shell/list-paging.js";
  import {
    DEFAULT_TOP_FOLDERS,
    WHOLE_COMPANY,
    cacheGrants,
    cacheGroups,
    cachedGrants,
    cachedGroups,
    grantSections,
    groupGrantSummaries,
    groupsFromBody,
    readCompanyGrants,
    topFoldersFromListing,
    type FolderRead,
  } from "./company-access.js";
  import type { CompanyGroup, PathGrant } from "./company-settings.js";
  import { readCompanyTeam, readTeamCache, seatCounts, writeTeamCache } from "./team-bots-pages.js";
  import type { TeamMember } from "./team-telemetry.js";
  import { loadPeople } from "../common/people/people-roster.svelte.js";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    slug: string;
    companyLabel: string;
    openExternal?: (url: string) => void;
    /** Team roster source, shared with the Team page (QA-046). */
    companyUid?: string | null;
    company?: CompanyApi | null;
    messaging?: MessagingApi | null;
    /** RELEASE-001 gate: false hides the plan seat-limit line on Workforce. */
    seatLimit?: boolean;
    /** OWNER-R24: which company panel pane this is. */
    section?: "general" | "brand" | "groups" | "grants" | "billing";
    /** OWNER-R24: the caller's role; only an Owner edits General and Brand. */
    role?: string | null;
    /** Vault reads for the live Groups and Grants panes. */
    files?: FilesApi | null;
  }

  let { slug, companyLabel, openExternal, companyUid = null, company = null, messaging = null, seatLimit = true, section = "general", role = null, files = null }: Props = $props();

  // OWNER-R24: one pane per panel row; Billing carries the plan (seats and
  // hosted agents, formerly "HQ Workforce") at its top.
  const tab = $derived<SettingsTab>(section);
  const showPlan = $derived(section === "billing");
  const canEdit = $derived(role === "Owner");
  let saved = $state("");
  let grantFilter = $state<GrantFilter>("all");
  let selectedGroup = $state<string | null>(null);
  let snap = $state<SettingsSnapshot>(emptySnapshot("", ""));
  const dirty = $derived(saved !== "" && JSON.stringify({ g: snap.general, b: snap.brand }) !== saved);

  $effect(() => {
    const key = slug;
    const label = companyLabel;
    const next = readSettingsCache(key) ?? emptySnapshot(label, key);
    snap = next;
    saved = JSON.stringify({ g: next.general, b: next.brand });
  });
  $effect(() => {
    void loadPeople({ slug, companyUid, company, messaging });
  });

  // HQ Workforce seats come from the same roster as Team. The Team cache
  // paints first; the roster re-reads every time the Workforce tab opens.
  let rosterHumans = $state<number | null>(null);
  let rosterAgents = $state<TeamMember[]>([]);
  let rosterError = $state<string | null>(null);

  function applyTeam(key: string): void {
    const hit = readTeamCache(key);
    if (!hit) return;
    rosterHumans = seatCounts(hit.view).seats;
    rosterAgents = hit.view.agents;
  }

  $effect(() => {
    if (!showPlan) return;
    const key = slug;
    rosterHumans = null;
    rosterAgents = [];
    rosterError = null;
    applyTeam(key);
    if (!company || !key) return;
    const api = company;
    let cancelled = false;
    void readCompanyTeam({ slug: key, companyUid, company: api, messaging })
      .then((read) => {
        if (cancelled) return;
        if (read.error) {
          if (rosterHumans === null) rosterError = "Could not read the team. Seat count unavailable.";
          return;
        }
        const prior = readTeamCache(key);
        writeTeamCache(key, { view: read.view, invites: read.invites.length ? read.invites : (prior?.invites ?? []) });
        applyTeam(key);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[settings] workforce roster read failed", err);
        if (rosterHumans === null) rosterError = "Could not read the team. Seat count unavailable.";
      });
    return () => {
      cancelled = true;
    };
  });

  const hostedAgentCount = $derived(snap.agents.length || rosterAgents.length);

  // Live Groups and Grants. Sync does not feed these panes: they read hq-pro
  // when opened, paint the last good read first, and show loading and failed
  // states instead of a silent zero.
  type ReadState = "unavailable" | "loading" | "ready" | "failed";
  const accessPane = $derived(tab === "groups" || tab === "grants");
  const canRead = $derived(Boolean(companyUid && files?.listAccessGroups && files?.getAccessTree));
  let liveGroups = $state<CompanyGroup[]>([]);
  let groupsState = $state<ReadState>("loading");
  let liveGrants = $state<PathGrant[]>([]);
  let grantFolders = $state<FolderRead[]>([]);
  let grantsState = $state<ReadState>("loading");
  let grantsProgress = $state<{ done: number; total: number } | null>(null);
  let accessNonce = $state(0);
  let openFolder = $state<string | null>(null);

  async function topFolders(): Promise<string[]> {
    if (!files || !slug) return [...DEFAULT_TOP_FOLDERS];
    try {
      const res = await files.listDir(`companies/${slug}`);
      const names = res.ok ? topFoldersFromListing(res.value) : [];
      if (!res.ok) console.warn("[settings] company folder listing failed; using default folders", res.code);
      return names.length ? names : [...DEFAULT_TOP_FOLDERS];
    } catch (err) {
      console.warn("[settings] company folder listing threw; using default folders", err);
      return [...DEFAULT_TOP_FOLDERS];
    }
  }

  $effect(() => {
    void accessNonce;
    if (!accessPane) return;
    const uid = companyUid;
    const api = files;
    if (!uid || !api?.listAccessGroups || !api.getAccessTree) {
      groupsState = "unavailable";
      grantsState = "unavailable";
      return;
    }
    const readGroups = api.listAccessGroups.bind(api);
    const readTree = api.getAccessTree.bind(api);
    let cancelled = false;
    const hitGroups = cachedGroups(uid);
    const hitGrants = cachedGrants(uid);
    liveGroups = hitGroups ?? [];
    groupsState = hitGroups ? "ready" : "loading";
    liveGrants = hitGrants?.grants ?? [];
    grantFolders = hitGrants?.folders ?? [];
    grantsState = hitGrants ? "ready" : "loading";
    grantsProgress = null;

    void (async () => {
      let names = new Map<string, string>();
      try {
        const res = await readGroups(uid);
        if (cancelled) return;
        if (!res.ok) throw new Error(res.code ?? res.message ?? "groups read failed");
        const groups = groupsFromBody(res.value);
        cacheGroups(uid, groups);
        liveGroups = groups;
        groupsState = "ready";
        names = new Map(groups.map((g) => [g.id, g.name]));
      } catch (err) {
        if (cancelled) return;
        console.warn("[settings] groups read failed", err);
        if (!hitGroups) groupsState = "failed";
        names = new Map((hitGroups ?? []).map((g) => [g.id, g.name]));
      }
      try {
        const folders = await topFolders();
        if (cancelled) return;
        const read = await readCompanyGrants({
          readTree,
          companyUid: uid,
          folders,
          ctx: { groupNames: names },
          onProgress: (done, total) => {
            if (!cancelled) grantsProgress = { done, total };
          },
        });
        if (cancelled) return;
        const allFailed = read.folders.length > 0 && read.folders.every((f) => f.status === "failed");
        if (allFailed) {
          if (!hitGrants) grantsState = "failed";
          return;
        }
        cacheGrants(uid, read);
        liveGrants = read.grants;
        grantFolders = read.folders;
        grantsState = "ready";
      } catch (err) {
        if (cancelled) return;
        console.warn("[settings] grants read failed", err);
        if (!hitGrants) grantsState = "failed";
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!liveGroups.some((g) => g.id === selectedGroup)) selectedGroup = liveGroups[0]?.id ?? null;
  });

  const visibleGrants = $derived(filterGrants(liveGrants, grantFilter));
  const sections = $derived(grantSections(visibleGrants));
  const groupSummaries = $derived(groupGrantSummaries(liveGrants));
  const unreadFolders = $derived(grantFolders.filter((f) => f.status !== "ok"));
  const group = $derived(liveGroups.find((g) => g.id === selectedGroup) ?? liveGroups[0] ?? null);
  let rowPages = $state(1);
  const openRows = $derived(pageRows(sections.find((s) => s.folder === openFolder)?.grants ?? [], rowPages));
  const folderLabel = (folder: string): string => (folder === WHOLE_COMPANY ? "Whole company" : `${folder}/`);
  const n = (value: number): string => value.toLocaleString();

  function remember(): void {
    writeSettingsCache(slug, snap);
    saved = JSON.stringify({ g: snap.general, b: snap.brand });
  }

  function saveGeneral(): void {
    remember();
  }

  function openStripe(action: "upgrade" | "portal"): void {
    const url = stripeDestination(action);
    openExternal?.(url);
  }

</script>

<section
  class="settings"
  data-testid="company-settings"
  data-scene="settings"
  data-tab={tab}
  data-scroll-budget={metadata.performanceBudget.scrollDroppedFramesPct}
>
  <div class="page">
    {#if tab === "general"}
      <div class="page-head">
        <div>
          <h2>General</h2>
          <p class="sub">Name, slug, defaults for new members, ownership</p>
        </div>
        <span class="grow"></span>
        {#if canEdit}<RailButton icon="check" variant="primary" type="button" data-testid="settings-save" disabled={!dirty} onclick={saveGeneral}>Save</RailButton>{/if}
      </div>
      <fieldset class="fs" disabled={!canEdit}>
      <label class="fr"><span class="lb">Company name</span><input class="in" bind:value={snap.general.name} /></label>
      <label class="fr"><span class="lb">Slug</span><input class="in mono" bind:value={snap.general.slug} /></label>
      <label class="fr"><span class="lb">Website</span><input class="in" bind:value={snap.general.website} placeholder="https://" /></label>
      <label class="fr">
        <span class="lb">Default vault access<small>What a new Member can reach before any group</small></span>
        <textarea class="in mono ta" bind:value={snap.general.defaultAccess}></textarea>
      </label>
      <label class="fr"><span class="lb">Meeting bot<small>display name</small></span><input class="in" bind:value={snap.general.meetingBotName} /></label>
      </fieldset>
      {#if !canEdit}<p class="note" data-testid="settings-owner-note">Only the owner can change these.</p>{/if}
    {:else if tab === "brand"}
      <div class="page-head">
        <div>
          <h2>Brand</h2>
          <p class="sub">Accent color and voice</p>
        </div>
        <span class="grow"></span>
        <div class="seg" role="tablist">
          <button type="button" class="tab" role="tab" aria-selected={snap.brand.appearance === "light"} onclick={() => (snap.brand.appearance = "light")}>Light</button>
          <button type="button" class="tab" role="tab" aria-selected={snap.brand.appearance === "dark"} onclick={() => (snap.brand.appearance = "dark")}>Dark</button>
        </div>
        {#if canEdit}<RailButton icon="check" variant="primary" type="button" data-testid="brand-save" disabled={!dirty} onclick={remember}>Save</RailButton>{/if}
      </div>
      <fieldset class="fs" disabled={!canEdit}>
      <p class="note">The accent color tints this company's buttons and highlights. The live indicator stays green.</p>
      <label class="fr"><span class="lb">Accent</span><input class="in mono" bind:value={snap.brand.accent} placeholder="#4F46E5" /></label>
      <label class="fr"><span class="lb">Voice notes</span><textarea class="in ta" bind:value={snap.brand.voice}></textarea></label>
      <label class="fr"><span class="lb">Bot branding</span><input class="in" bind:value={snap.brand.botIntro} /></label>
      </fieldset>
      {#if !canEdit}<p class="note">Only the owner can change these.</p>{/if}
    {:else if tab === "groups"}
      <div class="page-head">
        <div>
          <h2>Groups</h2>
          <p class="sub" data-testid="groups-sub">{groupsState === "ready" ? `${n(liveGroups.length)} groups · ` : ""}share file and secret access with people and agents</p>
        </div>
      </div>
      {#if groupsState === "loading"}
        <ReadLoader testid="groups-loading" onretry={() => (accessNonce += 1)} />
      {:else if groupsState === "failed"}
        <p class="note" data-testid="groups-failed">Could not read this company's groups.</p>
        <RailButton icon="refresh" type="button" data-testid="groups-retry" onclick={() => (accessNonce += 1)}>Try again</RailButton>
      {:else if groupsState === "unavailable"}
        <p class="note" data-testid="groups-unavailable">Groups are read from the company vault. This company is not in the cloud on this device.</p>
      {:else if liveGroups.length === 0}
        <p class="note" data-testid="groups-empty">This company has no groups yet.</p>
      {:else}
        <div class="split">
          <div class="list" data-testid="groups-list">
            {#each liveGroups as g (g.id)}
              <button type="button" class="row" data-testid="group-row" aria-current={group?.id === g.id ? "true" : undefined} onclick={() => (selectedGroup = g.id)}>
                <span class="t">{g.name}</span>{#if typeof g.memberCount === "number"}<span class="count">{n(g.memberCount)}</span>{/if}
              </button>
            {/each}
          </div>
          {#if group}
            {@const summary = groupSummaries.get(group.id) ?? null}
            <div data-testid="group-detail">
              <div class="page-head">
                <div>
                  <h2 class="h-sm">{group.name}</h2>
                  <p class="sub mono">{group.id}</p>
                </div>
              </div>
              {#if group.description}<p class="note">{group.description}</p>{/if}
              <div class="line" data-testid="group-members">
                <span class="nm">Members</span>
                <span>{typeof group.memberCount === "number" ? `${n(group.memberCount)} people and bots` : "Not included in the group list"}</span>
              </div>
              <div class="line" data-testid="group-grants">
                <span class="nm">Folder grants</span>
                {#if summary}
                  <span>{n(summary.total)} · {summary.byLevel.admin ? `${n(summary.byLevel.admin)} admin, ` : ""}{n(summary.byLevel.write)} write, {n(summary.byLevel.read)} read</span>
                {:else if grantsState === "ready"}
                  <span>None</span>
                {:else if grantsState === "loading"}
                  <span class="c">Reading grants…</span>
                {:else}
                  <span class="c">Grants unavailable</span>
                {/if}
              </div>
              {#if summary}
                <div class="line"><span class="nm">In</span><span class="mono">{summary.folders.map(folderLabel).join(", ")}</span></div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {:else if tab === "grants"}
      <div class="page-head">
        <div>
          <h2>Grants</h2>
          <p class="sub" data-testid="grants-sub">
            {#if grantsState === "ready"}
              {n(liveGrants.length)} folder grants · {expiringGrantCount(liveGrants)} expire within 7 days
            {:else if grantsState === "loading" && grantsProgress}
              Reading grants · {grantsProgress.done} of {grantsProgress.total} folders
            {:else}
              Who can open which folders
            {/if}
          </p>
        </div>
      </div>
      {#if grantsState === "loading"}
        <ReadLoader testid="grants-loading" onretry={() => (accessNonce += 1)} />
      {:else if grantsState === "failed"}
        <p class="note" data-testid="grants-failed">Could not read this company's grants.</p>
        <RailButton icon="refresh" type="button" data-testid="grants-retry" onclick={() => (accessNonce += 1)}>Try again</RailButton>
      {:else if grantsState === "unavailable"}
        <p class="note" data-testid="grants-unavailable">Grants are read from the company vault. This company is not in the cloud on this device.</p>
      {:else}
      <div class="seg" role="tablist" data-testid="grant-filters">
        {#each GRANT_FILTERS as id (id)}
          <button type="button" class="tab" role="tab" aria-selected={grantFilter === id} data-testid={`grant-filter-${id}`} onclick={() => (grantFilter = id)}>
            {grantFilterLabel(id)}
          </button>
        {/each}
      </div>
      <div class="sec-hd"><span>Folder</span><span>People</span><span>Groups</span><span>Bots</span><span>Guests</span><span>Total</span></div>
      {#each sections as s (s.folder)}
        <button
          type="button"
          class="sec-row"
          data-testid="grant-section"
          data-folder={s.folder}
          aria-expanded={openFolder === s.folder}
          onclick={() => {
            openFolder = openFolder === s.folder ? null : s.folder;
            rowPages = 1;
          }}
        >
          <span class="mono nm">{folderLabel(s.folder)}</span>
          <span>{n(s.counts.person)}</span>
          <span>{n(s.counts.group)}</span>
          <span>{n(s.counts.agent)}</span>
          <span>{n(s.counts.guest)}</span>
          <span class="nm">{n(s.total)}</span>
        </button>
        {#if openFolder === s.folder}
          <div class="rows" data-testid="grant-rows">
            <div class="gt hd"><span>Who</span><span>Folder</span><span>Level</span><span>Expiry</span></div>
            {#each openRows.rows as g (g.id)}
              <div class="gt" data-testid="grant-row">
                <span class="nm" title={g.detail}>{g.principal}</span>
                <span class="mono">{g.path}</span>
                <span>{grantLevelLabel(g.level)}</span>
                <span class:soon={g.expiring}>{g.expiry}</span>
              </div>
            {/each}
            {#if openRows.remaining > 0}
              <ShowMoreRow shown={openRows.rows.length} total={openRows.total} next={openRows.next} noun="grants" testid="grant-rows-show-more" onmore={() => (rowPages += 1)} />
            {/if}
          </div>
        {/if}
      {:else}
        <p class="note" data-testid="grants-filter-empty">
          {grantFilter === "expiring" ? "No folder grants have an expiry date." : "No grants in this filter."}
        </p>
      {/each}
      {#if unreadFolders.length}
        <div class="unread" data-testid="grants-unread">
          {#each unreadFolders as f (f.folder)}
            <p class="note"><span class="mono">{folderLabel(f.folder)}</span> · {f.note}</p>
          {/each}
          <RailButton icon="refresh" type="button" data-testid="grants-retry-folders" onclick={() => (accessNonce += 1)}>Try again</RailButton>
        </div>
      {/if}
      {/if}
    {:else}
      <div class="page-head">
        <div>
          <h2>Billing</h2>
          <p class="sub">Plan, seats and payment · billed to {snap.general.name || companyLabel}</p>
        </div>
        <span class="grow"></span>
        <RailButton icon="external" type="button" data-testid="manage-payment" onclick={() => openStripe("portal")}>Manage payment</RailButton>
      </div>
      <div class="plan">
        <div data-testid="workforce-seats">
          <b>{rosterHumans ?? "–"}</b>{#if seatLimit && snap.seatsLimit !== null}<span data-testid="workforce-seat-limit"> of {snap.seatsLimit}</span>{/if}<span>Seats used · humans on Team</span>
        </div>
        <div data-testid="workforce-agents">
          <b>{hostedAgentCount}</b>{#if snap.agentsLimit !== null} of {snap.agentsLimit}{/if}<span>Hosted agents · counted separately</span>
        </div>
      </div>
      {#if rosterError}
        <p class="note" data-testid="workforce-error">{rosterError}</p>
      {/if}
      {#if seatLimit && snap.seatsLimit === null}
        <p class="note" data-testid="workforce-limit-unavailable">Plan limits are not available yet. Counts come from the Team roster.</p>
      {/if}
      <div class="up">
        <div>
          <b>Need more seats or agents?</b>
          Upgrade continues to Stripe checkout in your browser. The desktop collects no card data.
        </div>
        <RailButton icon="arrow-right" variant="primary" type="button" data-testid="workforce-upgrade" onclick={() => openStripe("upgrade")}>Upgrade</RailButton>
      </div>
      <p class="note">Manage payment opens the Stripe customer portal in your browser.</p>
    {/if}
  </div>
</section>

<style>
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .settings {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--t1);
    font-size: 13px;
    background: transparent;
  }
  .fs { border: 0; margin: 0; padding: 0; min-width: 0; display: contents; }
  .subnav, .page { min-height: 0; overflow: auto; }
  .subnav {
    border-right: 1px solid var(--line);
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .page { padding: 20px 20px 48px; }
  .row, .tab {
    font: inherit;
    font-size: 13px;
    color: var(--t2);
    background: transparent;
    border: 0;
    border-radius: 6px;
    text-align: left;
  }
  .row {
    height: 31px;
    box-sizing: border-box;
    padding: 7px 10px;
    line-height: 17px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .row:hover { background: var(--hover); }
  .row[aria-current="true"] { background: var(--sel); color: var(--t1); }
  .sec {
    padding: 12px 10px 4px;
    font-size: 13px;
    font-weight: 500;
    color: var(--t2);
  }
  .count { margin-left: auto; color: var(--t3); font-size: 13px; font-variant-numeric: tabular-nums; }
  .page-head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .page-head h2 { margin: 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  .h-sm { margin: 0; font-size: 13px; font-weight: 500; }
  .sub, .note { margin: 0; color: var(--t3); font-size: 13px; }
  .note { margin-top: 12px; max-width: 640px; line-height: 1.45; }
  .grow { flex: 1; }
  .fr {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }
  .lb { font-size: 13px; padding-top: 5px; }
  .lb small { display: block; color: var(--t3); font-size: 13px; font-weight: 400; }
  .in {
    min-height: 28px;
    max-width: 420px;
    border-radius: var(--v4-radius-field);
    background: var(--btn-bg);
    border: 1px solid var(--line2);
    color: var(--t1);
    padding: 4px 8px;
    font: inherit;
    font-size: 13px;
  }
  .ta { min-height: 60px; }
  .mono { font-family: var(--font-mono); font-size: 13px; }
  .seg { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--panel-border); border-radius: 6px; background: var(--hover); }
  .tab { padding: 4px 8px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); border-radius: 4px; }
  .sw { cursor: pointer; }
  .sw.on { color: var(--t1); }
  .split { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; }
  .line, .gt {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 80px 120px;
    gap: 8px;
    align-items: center;
    min-height: 31px;
    box-sizing: border-box;
    padding: 7px 8px;
    line-height: 17px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    color: var(--t2);
  }
  .gt.hd { color: var(--t3); }
  .sec-hd, .sec-row {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) repeat(5, 72px);
    gap: 8px;
    align-items: center;
    min-height: 31px;
    box-sizing: border-box;
    padding: 7px 8px;
    line-height: 17px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    color: var(--t2);
    font-variant-numeric: tabular-nums;
  }
  .sec-hd { color: var(--t3); margin-top: 12px; }
  .sec-row { width: 100%; font: inherit; font-size: 13px; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--line); cursor: pointer; }
  .sec-row:hover { background: var(--hover); }
  .sec-row[aria-expanded="true"] { background: var(--sel); }
  .rows { padding-left: 12px; }
  .unread { margin-top: 12px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .nm { color: var(--t1); }
  .soon { color: var(--t3); }
  .plan { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 520px; padding: 14px 16px; border-radius: 10px; background: var(--raised); }
  .plan span { display: block; color: var(--t3); font-size: 13px; }
  .up { display: flex; align-items: center; gap: 12px; margin-top: 18px; max-width: 720px; padding: 14px 16px; border-radius: 10px; background: var(--raised); }
</style>
