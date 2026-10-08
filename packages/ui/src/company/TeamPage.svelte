<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
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
  import { memberAccessDoor, profilePaneDoor } from "../shell/lazy-doors.js";
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
    /** OWNER-R9: the signed-in person, to read their own role here. */
    selfUid?: string | null;
    selfEmail?: string | null;
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
    selfUid = null,
    selfEmail = null,
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
  // BLANK-2: a failed read with nothing loaded shows only the failed line and
  // Try again; counts and empty lines wait for a read that succeeded.
  const failedEmpty = $derived(
    Boolean(view.error) && humans.length === 0 && bots.length === 0 && invites.length === 0,
  );
  // The sidepane Team row shows this same total (QA-014).
  $effect(() => {
    if (phase === "ready" && !failedEmpty) publishCompanyPageCount(slug, "team", humans.length + bots.length);
  });
  const showHumans = $derived(filter === "all" || filter === "humans");
  const showBots = $derived(filter === "all" || filter === "bots");
  const humanPage = $derived(pageRows(humans, humanPages));
  const botPage = $derived(pageRows(bots, botPages));
  const invitePage = $derived(pageRows(invites, invitePages));
  const openMember = $derived(
    openId ? ([...humans, ...bots].find((member) => member.id === openId) ?? null) : null,
  );
  // OWNER-R9: owners and admins change roles and remove members; everyone
  // else sees the values read-only with no controls.
  const callerRole = $derived(
    view.members.find(
      (m) => (selfUid && m.id === selfUid) || (selfEmail && m.email && m.email.toLowerCase() === selfEmail.toLowerCase()),
    )?.role ?? "",
  );
  const canManage = $derived(callerRole === "Owner" || callerRole === "Admin");
  const ownerCount = $derived(view.members.filter((m) => m.role === "Owner").length);
  let pendingRole = $state<{ id: string; role: string } | null>(null);
  let actionNote = $state("");
  function isSelf(member: TeamMember): boolean {
    return Boolean(selfUid && member.id === selfUid);
  }
  function manageable(member: TeamMember): boolean {
    return canManage && Boolean(member.membershipKey) && !isSelf(member) && !(callerRole === "Admin" && member.role === "Owner");
  }
  function lastOwner(member: TeamMember): boolean {
    return member.role === "Owner" && ownerCount <= 1;
  }
  const botNameFor = (id: string): string | null => bots.find((b) => b.id === id)?.displayName ?? null;
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
  // BLANK-3: with a saved team on screen, a refresh is quiet: "Refreshing…"
  // while it runs, and a failed refresh keeps the saved team with a small
  // "Couldn't refresh" line instead of replacing it with the failed state.
  let refreshing = $state(false);
  let refreshFailed = $state(false);

  $effect(() => {
    const key = slug;
    void readAttempt;
    const hit = readTeamCache(key);
    refreshing = Boolean(hit);
    refreshFailed = false;
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
        const read = await readCompanyTeam({
          slug: key,
          companyUid,
          company,
          messaging,
          // BLANK-3: people show as soon as the roster answers; the slower
          // telemetry fills in skills and activity when it arrives. A cached
          // view (which already has telemetry) is not replaced by the roster.
          onRoster: (early) => {
            if (cancelled || hit) return;
            view = early;
            phase = "ready";
          },
        });
        if (cancelled) return;
        refreshing = false;
        if (read.error) {
          if (hit) {
            refreshFailed = true;
            return;
          }
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
        refreshing = false;
        if (hit) {
          refreshFailed = true;
          return;
        }
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

  function patchMember(id: string, next: (row: TeamMember) => TeamMember | null): void {
    const map = (rows: TeamMember[]) =>
      rows.flatMap((row) => {
        if (row.id !== id) return [row];
        const out = next(row);
        return out ? [out] : [];
      });
    view = { ...view, humans: map(view.humans), agents: map(view.agents), members: map(view.members) };
  }

  /** OWNER-R9: confirmed role change through POST /membership/role; rolls back on failure. */
  async function setRole(member: TeamMember, role: string): Promise<void> {
    pendingRole = null;
    menuFor = null;
    if (!member.membershipKey || !companyUid || !company?.setMemberRole) return;
    const before = member.role;
    actionNote = "";
    patchMember(member.id, (row) => ({ ...row, role }));
    const res = await Promise.resolve(company.setMemberRole(companyUid, member.membershipKey, role.toLowerCase())).catch(
      (err: unknown) => {
        console.warn("[team] role change rejected", err);
        return { ok: false as const, reason: "network" as const, message: "rejected" };
      },
    );
    if (!res.ok) {
      console.warn("[team] role change failed", res.message ?? res.reason);
      patchMember(member.id, (row) => ({ ...row, role: before }));
      actionNote = `Couldn't change ${member.displayName}'s role. Nothing changed.`;
      return;
    }
    remember();
  }

  /** OWNER-R9: confirmed removal through POST /membership/revoke; rolls back on failure. */
  async function confirmRemove(): Promise<void> {
    if (!removeId) return;
    const id = removeId;
    const member = view.members.find((m) => m.id === id);
    removeId = null;
    menuFor = null;
    if (!member?.membershipKey || !companyUid || !company?.revokeMembership) return;
    const snapshot = view;
    actionNote = "";
    patchMember(id, () => null);
    const res = await Promise.resolve(company.revokeMembership(companyUid, member.membershipKey)).catch((err: unknown) => {
      console.warn("[team] remove rejected", err);
      return { ok: false as const, reason: "network" as const, message: "rejected" };
    });
    if (!res.ok) {
      console.warn("[team] remove failed", res.message ?? res.reason);
      view = snapshot;
      actionNote = `Couldn't remove ${member.displayName}. They are still on the team.`;
      return;
    }
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

  /** OWNER-R9: revoke a pending invite through POST /membership/revoke. */
  async function confirmRevoke(): Promise<void> {
    if (!revokeId) return;
    const id = revokeId;
    revokeId = null;
    const before = invites;
    invites = revokeInvite(invites, id, true);
    if (!companyUid || !company?.revokeMembership) return;
    const res = await Promise.resolve(company.revokeMembership(companyUid, id)).catch((err: unknown) => {
      console.warn("[team] revoke invite rejected", err);
      return { ok: false as const, reason: "network" as const, message: "rejected" };
    });
    if (!res.ok) {
      console.warn("[team] revoke invite failed", res.message ?? res.reason);
      invites = before;
      actionNote = "Couldn't revoke the invite. It is still pending.";
      return;
    }
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
    {#if !failedEmpty}
    <span class="meta-line" data-meta-line data-testid="team-live-chip">
      <i class="meta-dot dot" class:live={liveMembers > 0}></i>{liveMembers} live
    </span>
    <span class="meta-line" data-meta-line data-testid="team-seat-chip">{seatLine}</span>
    {/if}
    {#if refreshing}
      <span class="meta-line" data-meta-line aria-live="polite" data-testid="team-refreshing">Refreshing…</span>
    {:else if refreshFailed}
      <button type="button" class="meta-line quiet-retry" data-meta-line data-testid="team-refresh-failed" onclick={() => (readAttempt += 1)}><RailIcon name="refresh" />Couldn't refresh · Try again</button>
    {/if}
    <RailButton icon="user-plus" type="button" data-testid="invite-teammate" onclick={() => (inviteOpen = true)}>
      Invite teammate
    </RailButton>
    <RailButton icon="plus" variant="primary" type="button" data-testid="team-add-agent" onclick={() => onaddagent?.()}>
      Add agent
    </RailButton>
  </div>

  <div class="body">
  <div class="canvas">
    {#if actionNote}
      <p class="note action-note" role="status" data-testid="team-action-note">{actionNote}</p>
    {/if}
    {#if phase === "shimmer"}
      <ReadLoader testid="team-loader" surface="team" onretry={() => (readAttempt += 1)} />
    {:else}
      {#if view.error}
        <div class="note load-error" role="alert" data-testid="team-load-error">
          <p>{view.error}</p>
          <RailButton icon="refresh" data-testid="team-retry" onclick={() => (readAttempt += 1)}>Try again</RailButton>
        </div>
      {/if}
      {#if !failedEmpty}
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
            {#if canManage}
              <RailButton icon="trash"
                type="button"
                data-testid={`revoke-${invite.id}`}
                onclick={() => (revokeId = invite.id)}>Revoke</RailButton>
            {/if}
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
          <div class="profile-loading" aria-busy="true"><ReadLoader testid="team-profile-loading" /></div>
        {/snippet}
      </LazyDoor>
      {#if openMember.kind !== "agent"}
        <LazyDoor
          door={memberAccessDoor}
          props={{
            company,
            companyUid,
            personUid: openMember.id,
            joined: openMember.joined ?? "",
            role: openMember.role ?? "",
            badge: openMember.badge ?? "",
            botName: botNameFor,
          }}
        />
      {/if}
    </div>
  {/if}
  </div>

  {#if inviteOpen}
    <div class="scrim" data-testid="invite-sheet" data-scene="invite-teammate">
      <div class="sheet" role="dialog" aria-label="Invite teammate" use:dismissable={{ onclose: () => (inviteOpen = false), outside: true }}>
        <header class="sh">
          <span class="sh-title">Invite teammate</span>
          <button type="button" class="icon" aria-label="Close" onclick={() => (inviteOpen = false)}>
            <RailIcon name="x" size={14} />
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
            <RailIcon name="robot" size={12} />
          {:else}
            {initials(member.displayName)}
          {/if}
          <span class="ld" class:pulse={live(member)}></span>
        </span>
        <span class="nm">{member.displayName}</span>
        {#if member.email}<span class="meta em">{member.email}</span>{/if}
        {#if member.badge}<span class="meta badge" data-testid="team-badge">{member.badge}</span>{/if}
      </span>
      <span class="cell">{roleLine(member)}</span>
      <span class="cell meta">{working(member)}</span>
      <span class="cell meta r">{member.joined ?? ""}</span>
    </button>
    <span class="act">{#if manageable(member)}{@render rowMenu(member, bot)}{/if}</span>
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
    ><RailIcon name="dots-three" size={14} /></button>
    {#if menuFor === member.id}
      <div class="menu" role="menu" data-testid="team-row-menu">
        {#if pendingRole?.id === member.id}
          <span class="menu-note" data-testid="team-role-confirm">Make {member.displayName} {pendingRole.role === "Admin" ? "an" : "a"} {pendingRole.role}?</span>
          <button type="button" class="mi" role="menuitem" data-testid="team-role-confirm-yes" onclick={() => void setRole(member, pendingRole!.role)}>Change role</button>
          <button type="button" class="mi" role="menuitem" onclick={() => (pendingRole = null)}>Cancel</button>
        {:else}
          <span class="menu-note">Change role</span>
          {#each (callerRole === "Owner" ? ["Owner", "Admin", "Member"] : ["Admin", "Member"]) as role (role)}
            <button
              type="button"
              class="mi"
              role="menuitemradio"
              aria-checked={roleLine(member) === role}
              disabled={roleLine(member) === role || (lastOwner(member) && role !== "Owner")}
              data-testid={`team-role-${role.toLowerCase()}`}
              onclick={() => (pendingRole = { id: member.id, role })}
            >{role}</button>
          {/each}
          {#if lastOwner(member)}<span class="menu-note">A company needs at least one owner.</span>{/if}
          <button type="button" class="mi" role="menuitem" data-testid={`team-remove-${member.id}`} disabled={lastOwner(member)} onclick={() => (removeId = member.id)}>Remove</button>
        {/if}
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
  .tab, .icon, .row-main, .mi, .quiet-retry { position: relative; }
  .tab::after,
  .icon::after,
  .row-main::after,
  .mi::after,
  .quiet-retry::after {
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
  .quiet-retry { border: 0; background: none; padding: 0; color: inherit; font: inherit; cursor: pointer; }
  .badge { padding: 0 6px; border-radius: 999px; background: var(--hover); }
  .action-note { margin: 0 8px 8px; }
  .quiet-retry:hover { opacity: 0.7; }
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
    background: var(--overlay-bg, var(--panel-bg));
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
  .profile-loading { height: 100%; }
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
    background: var(--overlay-bg, var(--panel-bg));
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
</style>
