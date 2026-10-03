<script lang="ts">
  import { withReadDeadline } from "../common/read-deadline.js";
  import RailButton from "../common/button/RailButton.svelte";
  import { dismissable } from "../common/dismissable.js";
  import { publishCompanyPageCount } from "../shell/company-page-counts.svelte.js";
  /**
   * Company Team page (console-rail US-027).
   *
   * Same sources as TeamPanel: company.getTeamTelemetry and listMembers.
   * The last payload for this slug paints on the first frame; a refresh
   * runs after that. Pending invites revoke only through the confirm sheet.
   */
  import type { AgentsApi, CompanyApi, MessagingApi } from "@hq/platform";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import LazyDoor from "../shell/LazyDoor.svelte";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import { profilePaneDoor } from "../shell/lazy-doors.js";
  import { pageRows } from "../shell/list-paging.js";
  import { UNKNOWN_ROLE } from "../shell/account-menu.js";
  import type { TeamMember, TeamTelemetryView } from "./team-telemetry.js";
  import {
    INVITE_ROLES,
    TEAM_FILTERS,
    addInvite,
    emptyInviteDraft,
    inviteRoleFields,
    inviteRoleLabel,
    inviteSummary,
    metadata,
    readCompanyTeam,
    readTeamCache,
    resendInvite,
    revokeInvite,
    seatCounts,
    writeTeamCache,
    type InviteDraft,
    type PendingInvite,
    type TeamFilter,
  } from "./team-bots-pages.js";
  import { readSettingsCache } from "./company-settings.js";
  import { presenceStatus } from "../chat/presence-store.svelte.js";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/chat-tokens.css";

  interface Props {
    slug: string;
    companyUid?: string | null;
    company: CompanyApi | null;
    messaging?: MessagingApi | null;
    senderName?: string;
    /** Bot controls in the profile pane (jobs, usage, pause). */
    agents?: AgentsApi | null;
    /** Bumped by the sidepane Invite a teammate row; opens the invite sheet. */
    inviteSeq?: number;
    onaddagent?: () => void;
    onmessage?: (uid: string) => void;
  }

  let {
    slug,
    companyUid = null,
    company,
    messaging = null,
    senderName = "you",
    agents = null,
    inviteSeq = 0,
    onaddagent,
    onmessage,
  }: Props = $props();

  const emptyView: TeamTelemetryView = {
    members: [],
    humans: [],
    agents: [],
    error: null,
    empty: true,
  };

  let view = $state<TeamTelemetryView>(emptyView);
  let invites = $state<PendingInvite[]>([]);
  let phase = $state<"shimmer" | "ready">("shimmer");
  let filter = $state<TeamFilter>("all");
  let inviteOpen = $state(false);
  let draft = $state<InviteDraft>(emptyInviteDraft());
  let revokeId = $state<string | null>(null);
  let menuFor = $state<string | null>(null);
  let removeId = $state<string | null>(null);
  let groupQuery = $state("");
  let openId = $state<string | null>(null);
  let humanPages = $state(1);
  let botPages = $state(1);
  let invitePages = $state(1);
  let seenInviteSeq = 0;

  // The sidepane Invite a teammate row lands here with the sheet open.
  $effect(() => {
    if (inviteSeq > seenInviteSeq) {
      seenInviteSeq = inviteSeq;
      inviteOpen = true;
    }
  });

  const fields = $derived(inviteRoleFields(draft.role));
  const humans = $derived(view.humans);
  const bots = $derived(view.agents);
  // The sidepane Team row shows this same total (QA-014).
  $effect(() => {
    if (phase === "ready") publishCompanyPageCount(slug, "team", humans.length + bots.length);
  });
  const showHumans = $derived(filter === "all" || filter === "humans");
  const showBots = $derived(filter === "all" || filter === "bots");
  const humanPage = $derived(pageRows(humans, humanPages));
  const botPage = $derived(pageRows(bots, botPages));
  const invitePage = $derived(pageRows(invites, invitePages));
  const openMember = $derived(
    openId ? ([...humans, ...bots].find((member) => member.id === openId) ?? null) : null,
  );
  const seatLine = $derived.by(() => {
    const { seats } = seatCounts(view);
    const limit = readSettingsCache(slug)?.seatsLimit ?? null;
    const noun = seats === 1 ? "seat" : "seats";
    return limit && limit > 0 ? `${seats} of ${limit} ${noun}` : `${seats} ${noun}`;
  });
  const liveMembers = $derived(
    companyUid
      ? [...humans, ...bots].filter((member) => presenceStatus(companyUid, member.id) === "online").length
      : 0,
  );

  // AUDIT-3: Try again on a failed read re-runs the load below.
  let readAttempt = $state(0);

  $effect(() => {
    const key = slug;
    void readAttempt;
    const hit = readTeamCache(key);
    if (hit) {
      view = hit.view;
      invites = hit.invites;
      phase = "ready";
    } else {
      view = emptyView;
      invites = [];
      phase = "shimmer";
    }
    if (!company || !key) {
      phase = "ready";
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // BLANK-1: a read that never answers falls to the failed-read state.
        const read = await withReadDeadline(readCompanyTeam({ slug: key, companyUid, company, messaging }), "company team");
        if (cancelled) return;
        if (read.error) {
          view = { ...emptyView, error: read.error };
          phase = "ready";
          return;
        }
        const next = read.view;
        view = next;
        if (read.invites.length > 0) invites = read.invites;
        phase = "ready";
        writeTeamCache(key, { view: next, invites });
      } catch (err) {
        if (cancelled) return;
        console.warn("[team] read failed", err);
        view = { ...emptyView, error: "Could not read the team." };
        phase = "ready";
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function remember(): void {
    writeTeamCache(slug, { view, invites });
  }

  function roleLine(member: TeamMember): string {
    // QA-048: no invented role. Profile shows the same dash for this company.
    return member.role?.trim() || UNKNOWN_ROLE;
  }

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.trim().slice(0, 2).toUpperCase() || "?";
  }

  function live(member: TeamMember): boolean {
    return Boolean(companyUid) && presenceStatus(companyUid!, member.id) === "online";
  }

  function openProfile(member: TeamMember): void {
    menuFor = null;
    openId = openId === member.id ? null : member.id;
  }

  function setRole(member: TeamMember, role: string): void {
    const apply = (row: TeamMember) => (row.id === member.id ? { ...row, role } : row);
    view = {
      ...view,
      humans: view.humans.map(apply),
      agents: view.agents.map(apply),
      members: view.members.map(apply),
    };
    menuFor = null;
    remember();
  }

  function confirmRemove(): void {
    if (!removeId) return;
    const id = removeId;
    const drop = (row: TeamMember) => row.id !== id;
    view = {
      ...view,
      humans: view.humans.filter(drop),
      agents: view.agents.filter(drop),
      members: view.members.filter(drop),
    };
    removeId = null;
    menuFor = null;
    remember();
  }

  function working(member: TeamMember): string {
    if (member.activeProjects.length > 0) return member.activeProjects.join(" · ");
    if (member.topSkills.length > 0) return member.topSkills.map((s) => s.skill).join(" · ");
    return "Idle";
  }

  function submitInvite(): void {
    invites = addInvite(invites, draft, senderName);
    draft = emptyInviteDraft();
    inviteOpen = false;
    remember();
  }

  function confirmRevoke(): void {
    if (!revokeId) return;
    invites = revokeInvite(invites, revokeId, true);
    revokeId = null;
    remember();
  }
</script>

<section
  class="team-page"
  data-testid="team-page"
  data-scene="team"
  data-scroll-budget={metadata.performanceBudget.scrollDroppedFramesPct}
>
  <div class="toolbar">
    <h1>Team</h1>
    <div class="tabs" role="tablist">
      {#each TEAM_FILTERS as id (id)}
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={filter === id}
          data-testid={`team-filter-${id}`}
          onclick={() => (filter = id)}
        >
          {id === "all" ? "All" : id === "humans" ? "Humans" : "Bots"}
        </button>
      {/each}
    </div>
    <span class="grow"></span>
    <span class="meta-line" data-meta-line data-testid="team-live-chip">
      <i class="meta-dot dot" class:live={liveMembers > 0}></i>{liveMembers} live
    </span>
    <span class="meta-line" data-meta-line data-testid="team-seat-chip">{seatLine}</span>
    <RailButton icon="user-plus" type="button" data-testid="invite-teammate" onclick={() => (inviteOpen = true)}>
      Invite teammate
    </RailButton>
    <RailButton icon="plus" variant="primary" type="button" data-testid="team-add-agent" onclick={() => onaddagent?.()}>
      Add agent
    </RailButton>
  </div>

  <div class="body">
  <div class="canvas">
    {#if phase === "shimmer"}
      <div class="shimmer" data-testid="team-shimmer" aria-hidden="true">
        {#each [0, 1, 2, 3] as row (row)}
          <div class="shimmer-row"><span class="sk sk-av"></span><span class="sk"></span></div>
        {/each}
      </div>
    {:else}
      {#if view.error}
        <div class="note load-error" role="alert" data-testid="team-load-error">
          <p>{view.error}</p>
          <RailButton icon="refresh" data-testid="team-retry" onclick={() => (readAttempt += 1)}>Try again</RailButton>
        </div>
      {/if}
      {#if showHumans}
        <div class="sech" data-testid="team-section-label">Humans · {humans.length}</div>
        <div class="cols" aria-hidden="true">
          <span>Member</span><span>Role</span><span>Working on</span><span class="r">Joined</span><span></span>
        </div>
        <div class="list" role="list">
          {#each humanPage.rows as member (member.id)}
            {@render memberRow(member, false)}
          {:else}
            <p class="empty">No people yet.</p>
          {/each}
          {#if humanPage.remaining > 0}
            <ShowMoreRow shown={humanPage.rows.length} total={humanPage.total} next={humanPage.next} noun="people" onmore={() => (humanPages += 1)} testid="team-humans-more" />
          {/if}
        </div>
      {/if}
      {#if showBots}
        <div class="sech" data-testid="team-section-label">Bots · {bots.length}</div>
        <div class="cols" aria-hidden="true">
          <span>Agent</span><span>Role</span><span>Working on</span><span class="r">Enrolled</span><span></span>
        </div>
        <div class="list" role="list">
          {#each botPage.rows as member (member.id)}
            {@render memberRow(member, true)}
          {:else}
            <p class="empty">No bots yet.</p>
          {/each}
          {#if botPage.remaining > 0}
            <ShowMoreRow shown={botPage.rows.length} total={botPage.total} next={botPage.next} noun="bots" onmore={() => (botPages += 1)} testid="team-bots-more" />
          {/if}
        </div>
      {/if}
      <div class="sech" data-testid="team-section-label">Pending invites · {invites.length}</div>
      <ul class="inv" data-testid="pending-invites">
        {#each invitePage.rows as invite (invite.id)}
          <li>
            <span class="nm">{invite.email}</span>
            <span class="meta">{inviteSummary(invite)}</span>
            <RailButton icon="send"
              type="button"
              onclick={() => {
                invites = resendInvite(invites, invite.id);
                remember();
              }}>Resend</RailButton>
            <RailButton icon="trash"
              type="button"
              data-testid={`revoke-${invite.id}`}
              onclick={() => (revokeId = invite.id)}>Revoke</RailButton>
          </li>
        {:else}
          <li class="empty">No pending invites.</li>
        {/each}
      </ul>
      {#if invitePage.remaining > 0}
        <ShowMoreRow shown={invitePage.rows.length} total={invitePage.total} next={invitePage.next} noun="invites" onmore={() => (invitePages += 1)} testid="team-invites-more" />
      {/if}
      <p class="note">Invites go through the request-access funnel. Recipients confirm their email and appear here until they sign in.</p>
    {/if}
  </div>

  {#if openMember}
    <div class="profile" data-testid="team-profile-pane">
      <LazyDoor
        door={profilePaneDoor}
        props={{
          kind: openMember.kind === "agent" ? "bot" : "person",
          name: openMember.displayName,
          email: openMember.email ?? null,
          role: roleLine(openMember),
          company: slug,
          live: live(openMember),
          agentUid: openMember.kind === "agent" ? openMember.id : null,
          runtimeKind: openMember.kind === "agent" ? "cloud" : null,
          companyUid,
          agents,
          onclose: () => (openId = null),
          onmessage: () => onmessage?.(openMember.id),
        }}
      >
        {#snippet skeleton()}
          <div class="profile-skeleton" data-testid="team-profile-skeleton" aria-busy="true"></div>
        {/snippet}
      </LazyDoor>
    </div>
  {/if}
  </div>

  {#if inviteOpen}
    <div class="scrim" data-testid="invite-sheet" data-scene="invite-teammate">
      <div class="sheet" role="dialog" aria-label="Invite teammate" use:dismissable={{ onclose: () => (inviteOpen = false), outside: true }}>
        <header class="sh">
          <span class="sh-title">Invite teammate</span>
          <button type="button" class="icon" aria-label="Close" onclick={() => (inviteOpen = false)}>
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none" /></svg>
          </button>
        </header>
        <div class="fr">
          <label for="invite-email">Email</label>
          <input id="invite-email" class="fld" type="email" bind:value={draft.email} />
        </div>
        <div class="fr">
          <span>Role</span>
          <div class="seg" role="tablist">
            {#each INVITE_ROLES as role (role)}
              <button
                type="button"
                class="tab"
                aria-selected={draft.role === role}
                data-testid={`invite-role-${role}`}
                onclick={() => (draft.role = role)}
              >{inviteRoleLabel(role)}</button>
            {/each}
          </div>
        </div>
        {#if fields.showPrefixes}
          <div class="fr" data-testid="invite-prefixes">
            <label for="invite-prefixes">Guest prefixes</label>
            <textarea id="invite-prefixes" class="fld" rows="3" bind:value={draft.prefixesText} placeholder="projects/&lt;project&gt;/*"></textarea>
          </div>
        {/if}
        {#if fields.showGroups}
          <div class="fr" data-testid="invite-groups">
            <label for="invite-groups">Groups</label>
            <input id="invite-groups" class="fld" placeholder="Search groups…" bind:value={groupQuery} />
          </div>
        {/if}
        <footer class="sf">
          <span class="grow"></span>
          <RailButton icon="x" type="button" onclick={() => (inviteOpen = false)}>Cancel</RailButton>
          <RailButton icon="send" variant="primary" type="button" data-testid="invite-send" onclick={submitInvite}>Send invite</RailButton>
        </footer>
      </div>
    </div>
  {/if}
</section>

{#snippet memberRow(member: TeamMember, bot: boolean)}
  <div class="row" class:is-selected={openId === member.id} role="listitem" data-testid="team-row" data-member-id={member.id}>
    <button
      type="button"
      class="row-main"
      aria-label={`Open ${member.displayName} profile`}
      data-testid={`team-open-${member.id}`}
      onclick={() => openProfile(member)}
    >
      <span class="who">
        <span class="mini" class:sq={bot} aria-hidden="true">
          {#if bot}
            <svg viewBox="0 0 14 14" width="12" height="12"><rect x="2.5" y="4" width="9" height="7" rx="2" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M7 2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
          {:else}
            {initials(member.displayName)}
          {/if}
          <span class="ld" class:pulse={live(member)}></span>
        </span>
        <span class="nm">{member.displayName}</span>
        {#if member.email}<span class="meta em">{member.email}</span>{/if}
      </span>
      <span class="cell">{roleLine(member)}</span>
      <span class="cell meta">{working(member)}</span>
      <span class="cell meta r">{member.joined ?? ""}</span>
    </button>
    <span class="act">{@render rowMenu(member, bot)}</span>
  </div>
{/snippet}

{#snippet rowMenu(member: TeamMember, bot: boolean)}
  <div class="menu-wrap">
    <button
      type="button"
      class="icon"
      aria-label={`Actions for ${member.displayName}`}
      aria-expanded={menuFor === member.id}
      data-testid={`team-menu-${member.id}`}
      onclick={() => (menuFor = menuFor === member.id ? null : member.id)}
    ><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="3" cy="7" r="1" fill="currentColor" /><circle cx="7" cy="7" r="1" fill="currentColor" /><circle cx="11" cy="7" r="1" fill="currentColor" /></svg></button>
    {#if menuFor === member.id}
      <div class="menu" role="menu" data-testid="team-row-menu">
        <span class="menu-note">Change role</span>
        {#each ["Owner", "Admin", "Member"] as role (role)}
          <button type="button" class="mi" role="menuitemradio" aria-checked={roleLine(member) === role} onclick={() => setRole(member, role)}>{role}</button>
        {/each}
        <button type="button" class="mi" role="menuitem" data-testid={`team-remove-${member.id}`} onclick={() => (removeId = member.id)}>Remove</button>
        {#if bot}<span class="menu-note">Reports to its owner</span>{/if}
      </div>
    {/if}
  </div>
{/snippet}

<ConfirmDialog
  open={revokeId != null}
  title="Revoke invite?"
  message="This removes the pending invite. The person will not be able to join with it."
  confirmLabel="Revoke"
  danger
  oncancel={() => (revokeId = null)}
  onconfirm={confirmRevoke}
/>

<ConfirmDialog
  open={removeId != null}
  title="Remove member?"
  message="This removes them from the team list on this Mac. Their account is unchanged."
  confirmLabel="Remove"
  danger
  oncancel={() => (removeId = null)}
  onconfirm={confirmRemove}
/>

<style>
  /* Hit area (AUDIT-2-10..13): every control here has at least a 28x28 px
     clickable box. The ::after pad grows only the axes under 28 px, so the
     drawn size and layout stay as they are. Kept first so a later
     position rule (e.g. absolute) still wins. */
  .tab, .icon, .row-main, .mi { position: relative; }
  .tab::after,
  .icon::after,
  .row-main::after,
  .mi::after {
    content: "";
    position: absolute;
    inset: min(0px, calc(50% - 14px));
  }
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .team-page {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--t1);
    font-size: 13px;
    background: transparent;
  }
  /* Console-rail page chrome, measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px everywhere else, 31px rows, background-only selection. */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    flex: none;
    box-sizing: border-box;
    padding: 0 20px;
    border-bottom: 1px solid var(--line);
  }
  h1 {
    margin: 0 8px 0 0;
    font-size: var(--type-title, 20px);
    font-weight: var(--type-title-weight, 500);
    line-height: var(--type-title-line, 1.25);
    color: var(--t1);
  }
  .grow { flex: 1; }
  .tabs, .seg { display: inline-flex; gap: 2px; }
  .seg { padding: 2px; border: 1px solid var(--panel-border); border-radius: 6px; background: var(--hover); }
  .tab {
    height: 26px;
    border: 0;
    border-radius: 6px;
    padding: 0 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .seg .tab { height: auto; padding: 4px 8px; border-radius: 4px; }
  .tab:hover { background: var(--hover); color: var(--t1); }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }
  .icon:hover { background: var(--hover); color: var(--t1); }
  .meta-line { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); flex: none; }
  .dot.live { background: var(--ok); }
  .sech { margin: 20px 0 4px; padding: 0 8px; color: var(--t2); font-size: 13px; font-weight: 500; }
  .sech:first-child { margin-top: 0; }
  .meta { color: var(--t3); font-size: 13px; }
  .empty { margin: 0; padding: 7px 8px; color: var(--t3); font-size: 13px; line-height: 17px; }
  .note { margin: 16px 8px 0; color: var(--t3); font-size: 13px; }
  .load-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .load-error p { margin: 0; }
  .scrim { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); z-index: 20; }
  .sheet {
    width: 480px;
    max-width: calc(100% - 32px);
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    box-shadow: var(--panel-shadow);
    color: var(--t1);
  }
  .sh { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 10px 0 20px; border-bottom: 1px solid var(--line); }
  .sh-title { flex: 1; font-size: 13px; font-weight: 500; }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); }
  .fr { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 10px 20px; align-items: center; font-size: 13px; color: var(--t2); }
  .fld {
    width: 100%;
    box-sizing: border-box;
    min-height: 28px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    padding: 4px 8px;
  }
  .body { flex: 1; min-height: 0; display: flex; }
  .canvas { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px 12px 24px; }
  .profile { flex: 0 0 340px; width: 340px; min-height: 0; border-left: 1px solid var(--line); display: flex; flex-direction: column; }
  .profile-skeleton { height: 100%; }
  .cols, .row-main {
    display: grid;
    grid-template-columns: minmax(180px, 2fr) minmax(90px, 1fr) minmax(120px, 2fr) 96px;
    gap: 12px;
    align-items: center;
  }
  .cols { padding: 0 44px 4px 8px; color: var(--t3); font-size: 13px; }
  .list { display: flex; flex-direction: column; }
  .row { position: relative; display: flex; align-items: center; border-radius: 8px; }
  .row:hover { background: var(--hover); }
  .row.is-selected { background: var(--sel); }
  .row-main {
    flex: 1;
    min-width: 0;
    height: 31px;
    box-sizing: border-box;
    padding: 7px 8px;
    border: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    line-height: 17px;
    text-align: left;
    cursor: pointer;
  }
  .row-main > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who { display: flex; align-items: center; gap: 8px; }
  .nm { color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font-size: 9px;
    font-weight: 500;
  }
  .mini.sq { border-radius: 5px; color: var(--t2); }
  .ld {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--t3);
    box-shadow: 0 0 0 1.5px var(--side-bg, transparent);
  }
  .ld.pulse { background: var(--ok); }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .act { flex: 0 0 36px; display: inline-flex; justify-content: center; }
  .menu-wrap { position: relative; display: inline-flex; }
  .menu {
    position: absolute;
    right: 0;
    top: 26px;
    z-index: 5;
    min-width: 160px;
    padding: 4px;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    box-shadow: var(--panel-shadow);
  }
  .menu button {
    display: block;
    width: 100%;
    height: 28px;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--t1);
    padding: 0 8px;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .menu button:hover { background: var(--hover); }
  .menu-note { display: block; padding: 4px 8px; color: var(--t3); font-size: 13px; }
  .inv { list-style: none; margin: 0; padding: 0; }
  .inv li { display: flex; align-items: center; gap: 8px; min-height: 31px; box-sizing: border-box; padding: 2px 8px; border-radius: 8px; }
  .inv li:hover { background: var(--hover); }
  .inv li .meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inv li.empty:hover { background: transparent; }
  .shimmer-row { display: flex; align-items: center; gap: 8px; height: 31px; padding: 0 8px; }
  .sk { display: inline-block; width: 160px; height: 10px; border-radius: 4px; background: var(--line); }
  .sk-av { width: 20px; height: 20px; border-radius: 50%; }
</style>
