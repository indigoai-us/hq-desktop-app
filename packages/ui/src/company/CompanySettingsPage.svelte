<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Company settings (console-rail US-030).
   * General, Brand, Groups, Grants, HQ Workforce, and Billing.
   * Cached snapshot paints on the first frame. Upgrade opens Stripe checkout.
   * Manage payment opens the Stripe portal. Delete group asks first.
   */
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import {
    GRANT_FILTERS,
    SETTINGS_TABS,
    deleteGroup,
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
  import type { CompanyApi, MessagingApi } from "@hq/platform";
  import { readCompanyTeam, readTeamCache, seatCounts, writeTeamCache } from "./team-bots-pages.js";
  import type { TeamMember } from "./team-telemetry.js";
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
  }

  let { slug, companyLabel, openExternal, companyUid = null, company = null, messaging = null, seatLimit = true }: Props = $props();

  let tab = $state<SettingsTab>("general");
  let grantFilter = $state<GrantFilter>("all");
  let selectedGroup = $state<string | null>(null);
  let deleteId = $state<string | null>(null);
  let snap = $state<SettingsSnapshot>(emptySnapshot("", ""));

  $effect(() => {
    const key = slug;
    const label = companyLabel;
    const hit = readSettingsCache(key);
    snap = hit ?? emptySnapshot(label, key);
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
    if (tab !== "workforce") return;
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

  $effect(() => {
    if (!selectedGroup && snap.groups[0]) selectedGroup = snap.groups[0].id;
  });

  const visibleGrants = $derived(filterGrants(snap.grants, grantFilter));
  const group = $derived(snap.groups.find((g) => g.id === selectedGroup) ?? snap.groups[0] ?? null);

  function remember(): void {
    writeSettingsCache(slug, snap);
  }

  function saveGeneral(): void {
    remember();
  }

  function openStripe(action: "upgrade" | "portal"): void {
    const url = stripeDestination(action);
    openExternal?.(url);
  }

  function confirmDelete(): void {
    if (!deleteId) return;
    snap = { ...snap, groups: deleteGroup(snap.groups, deleteId, true) };
    if (selectedGroup === deleteId) selectedGroup = snap.groups[0]?.id ?? null;
    deleteId = null;
    remember();
  }

  const tabLabel: Record<SettingsTab, string> = {
    general: "General",
    brand: "Brand",
    groups: "Groups",
    grants: "Grants",
    workforce: "HQ Workforce",
    billing: "Billing",
  };
</script>

<section
  class="settings"
  data-testid="company-settings"
  data-scene="settings"
  data-tab={tab}
  data-scroll-budget={metadata.performanceBudget.scrollDroppedFramesPct}
>
  <nav class="subnav" aria-label="Settings sections">
    {#each SETTINGS_TABS as id (id)}
      {#if id === "workforce"}
        <div class="sec">Plan</div>
      {/if}
      <button
        type="button"
        class="row"
        aria-current={tab === id ? "true" : undefined}
        data-testid={`settings-tab-${id}`}
        onclick={() => (tab = id)}
      >
        <span class="t">{tabLabel[id]}</span>
        {#if id === "groups" && snap.groups.length}
          <span class="count">{snap.groups.length}</span>
        {/if}
        {#if id === "grants" && expiringGrantCount(snap.grants)}
          <span class="count">{expiringGrantCount(snap.grants)}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="page">
    {#if tab === "general"}
      <div class="page-head">
        <div>
          <h2>General</h2>
          <p class="sub">Name, slug, defaults for new members, ownership</p>
        </div>
        <span class="grow"></span>
        <RailButton icon="check" variant="primary" type="button" data-testid="settings-save" onclick={saveGeneral}>Save changes</RailButton>
      </div>
      <label class="fr"><span class="lb">Company name</span><input class="in" bind:value={snap.general.name} /></label>
      <label class="fr"><span class="lb">Slug</span><input class="in mono" bind:value={snap.general.slug} /></label>
      <label class="fr"><span class="lb">Website</span><input class="in" bind:value={snap.general.website} placeholder="https://" /></label>
      <label class="fr">
        <span class="lb">Default vault access<small>What a new Member can reach before any group</small></span>
        <textarea class="in mono ta" bind:value={snap.general.defaultAccess}></textarea>
      </label>
      <div class="fr">
        <span class="lb">Default company<small>for members</small></span>
        <button type="button" class="sw" class:on={snap.general.openOnSignIn} aria-pressed={snap.general.openOnSignIn} onclick={() => (snap.general.openOnSignIn = !snap.general.openOnSignIn)}>
          Open {snap.general.name || "this company"} on sign-in for members
        </button>
      </div>
      <label class="fr"><span class="lb">Meeting bot<small>display name</small></span><input class="in" bind:value={snap.general.meetingBotName} /></label>
      <p class="note">Only the company owner can change these settings. Archive and ownership transfer stay on the web console.</p>
    {:else if tab === "brand"}
      <div class="page-head">
        <div>
          <h2>Brand</h2>
          <p class="sub">Logo, accent color, and voice</p>
        </div>
        <span class="grow"></span>
        <div class="seg" role="tablist">
          <button type="button" class="tab" role="tab" aria-selected={snap.brand.appearance === "light"} onclick={() => (snap.brand.appearance = "light")}>Light</button>
          <button type="button" class="tab" role="tab" aria-selected={snap.brand.appearance === "dark"} onclick={() => (snap.brand.appearance = "dark")}>Dark</button>
        </div>
        <RailButton icon="check" variant="primary" type="button" onclick={remember}>Save changes</RailButton>
      </div>
      <label class="fr"><span class="lb">Logo<small>file name</small></span><input class="in" bind:value={snap.brand.logoName} placeholder="wordmark.svg" /></label>
      <p class="note">The logo shows on this company's rail tile. The accent color tints this company's buttons and highlights. The live indicator stays green.</p>
      <label class="fr"><span class="lb">Accent</span><input class="in mono" bind:value={snap.brand.accent} placeholder="#4F46E5" /></label>
      <label class="fr"><span class="lb">Voice notes</span><textarea class="in ta" bind:value={snap.brand.voice}></textarea></label>
      <label class="fr"><span class="lb">Bot branding</span><input class="in" bind:value={snap.brand.botIntro} /></label>
    {:else if tab === "groups"}
      <div class="page-head">
        <div>
          <h2>Groups</h2>
          <p class="sub">{snap.groups.length} groups · share file and secret access with people and agents</p>
        </div>
      </div>
      {#if snap.groups.length === 0}
        <p class="note" data-testid="groups-empty">No groups yet. Groups from the company vault appear here after the next sync.</p>
      {:else}
        <div class="split">
          <div class="list">
            {#each snap.groups as g (g.id)}
              <button type="button" class="row" aria-current={group?.id === g.id ? "true" : undefined} onclick={() => (selectedGroup = g.id)}>
                <span class="t">{g.name}</span><span class="count">{g.members.length}</span>
              </button>
            {/each}
          </div>
          {#if group}
            <div>
              <div class="page-head">
                <div>
                  <h2 class="h-sm">{group.name}</h2>
                  <p class="sub">{group.description}</p>
                </div>
                <span class="grow"></span>
                <RailButton icon="trash" type="button" data-testid="delete-group" onclick={() => (deleteId = group.id)}>Delete group</RailButton>
              </div>
              {#each group.members as m (m.id)}
                <div class="line"><span class="nm">{m.name}</span><span class="c">{m.role}</span><span class="c">{m.added}</span></div>
              {/each}
              {#each group.paths as p (p.path)}
                <div class="line"><span class="mono">{p.path}</span><span class="c">{grantLevelLabel(p.level)}</span></div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {:else if tab === "grants"}
      <div class="page-head">
        <div>
          <h2>Grants</h2>
          <p class="sub">{snap.grants.length} active folder grants · {expiringGrantCount(snap.grants)} expire within 7 days</p>
        </div>
      </div>
      <div class="seg" role="tablist" data-testid="grant-filters">
        {#each GRANT_FILTERS as id (id)}
          <button type="button" class="tab" role="tab" aria-selected={grantFilter === id} data-testid={`grant-filter-${id}`} onclick={() => (grantFilter = id)}>
            {grantFilterLabel(id)}
          </button>
        {/each}
      </div>
      <div class="gt hd"><span>Principal</span><span>Folder</span><span>Level</span><span>Expiry</span></div>
      {#each visibleGrants as g (g.id)}
        <div class="gt" data-testid="grant-row">
          <span class="nm">{g.principal}</span>
          <span class="mono">{g.path}</span>
          <span>{grantLevelLabel(g.level)}</span>
          <span class:soon={g.expiring}>{g.expiry}</span>
        </div>
      {:else}
        <p class="note">No grants in this filter. Levels are read or write.</p>
      {/each}
    {:else if tab === "workforce"}
      <div class="page-head">
        <div>
          <h2>HQ Workforce</h2>
          <p class="sub">Team plan · billed to {snap.general.name || companyLabel}</p>
        </div>
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
      {#each snap.agents as a (a.id)}
        <div class="line">
          <span class="nm">{a.name}</span>
          <span class="mono">{a.box}</span>
          <span class:live={a.healthy}>{a.health}</span>
          <span class="c">{a.task}</span>
        </div>
      {:else}
        {#each rosterAgents as a (a.id)}
          <div class="line">
            <span class="nm">{a.displayName}</span>
          </div>
        {:else}
          <p class="note">Hosted agents show here after the roster refresh. Local bots on an Outpost do not count.</p>
        {/each}
      {/each}
      <div class="up">
        <div>
          <b>Need more seats or agents?</b>
          Upgrade continues to Stripe checkout in your browser. The desktop collects no card data.
        </div>
        <RailButton icon="arrow-right" variant="primary" type="button" data-testid="workforce-upgrade" onclick={() => openStripe("upgrade")}>Upgrade</RailButton>
      </div>
    {:else}
      <div class="page-head">
        <div>
          <h2>Billing</h2>
          <p class="sub">Payment method and invoices live in Stripe</p>
        </div>
      </div>
      <p class="note">Manage payment opens the Stripe customer portal in the system browser.</p>
      <RailButton icon="external" type="button" data-testid="manage-payment" onclick={() => openStripe("portal")}>Manage payment</RailButton>
    {/if}
  </div>
</section>

<ConfirmDialog
  open={deleteId !== null}
  title={group && deleteId === group.id ? `Delete the ${group.name} group?` : "Delete this group?"}
  message="Grants and workers that reference this group lose it. People keep every direct grant on their own name."
  confirmLabel="Delete"
  danger
  onconfirm={confirmDelete}
  oncancel={() => (deleteId = null)}
/>

<style>
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .settings {
    display: grid;
    grid-template-columns: 176px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--t1);
    font-size: 13px;
    background: transparent;
  }
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
  .nm { color: var(--t1); }
  .soon { color: var(--t3); }
  .live { color: var(--t2); }
  .live::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--ok); vertical-align: 1px; }
  .plan { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 520px; padding: 14px 16px; border-radius: 10px; background: var(--raised); }
  .plan span { display: block; color: var(--t3); font-size: 13px; }
  .up { display: flex; align-items: center; gap: 12px; margin-top: 18px; max-width: 720px; padding: 14px 16px; border-radius: 10px; background: var(--raised); }
</style>
