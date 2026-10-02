<script lang="ts">
  /**
   * Company Team page (console-rail US-027).
   *
   * Same sources as TeamPanel: company.getTeamTelemetry and listMembers.
   * The last payload for this slug paints on the first frame; a refresh
   * runs after that. Pending invites revoke only through the confirm sheet.
   */
  import type { CompanyApi, MessagingApi } from "@hq/platform";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import {
    normalizeCompanyTeamTelemetry,
    type TeamMember,
    type TeamTelemetryView,
  } from "./team-telemetry.js";
  import {
    INVITE_ROLES,
    TEAM_FILTERS,
    addInvite,
    emptyInviteDraft,
    inviteRoleFields,
    inviteRoleLabel,
    inviteSummary,
    metadata,
    pendingInvitesFromTelemetry,
    readTeamCache,
    resendInvite,
    revokeInvite,
    writeTeamCache,
    type InviteDraft,
    type PendingInvite,
    type TeamFilter,
  } from "./team-bots-pages.js";
  import { readSettingsCache } from "./company-settings.js";
  import { presenceStatus } from "../chat/presence-store.svelte.js";
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";

  interface Props {
    slug: string;
    companyUid?: string | null;
    company: CompanyApi | null;
    messaging?: MessagingApi | null;
    senderName?: string;
    onaddagent?: () => void;
  }

  let {
    slug,
    companyUid = null,
    company,
    messaging = null,
    senderName = "you",
    onaddagent,
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

  const fields = $derived(inviteRoleFields(draft.role));
  const humans = $derived(view.humans);
  const bots = $derived(view.agents);
  const showHumans = $derived(filter === "all" || filter === "humans");
  const showBots = $derived(filter === "all" || filter === "bots");
  const seatLine = $derived.by(() => {
    const settings = readSettingsCache(slug);
    const used = humans.length + bots.length;
    if (settings && settings.seatsLimit > 0) return `${settings.seatsUsed} of ${settings.seatsLimit} seats`;
    return `${used} seats`;
  });
  const liveMembers = $derived(
    companyUid
      ? [...humans, ...bots].filter((member) => presenceStatus(companyUid, member.id) === "online").length
      : 0,
  );

  $effect(() => {
    const key = slug;
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
        const [rawRes, members] = await Promise.all([
          company.getTeamTelemetry(key),
          company.listMembers(key).catch(() => null),
        ]);
        if (cancelled) return;
        if (!rawRes.ok) {
          view = { ...emptyView, error: rawRes.message || "Could not read the team." };
          phase = "ready";
          return;
        }
        const labels: Record<string, { email?: string | null; displayName?: string | null }> = {};
        if (members && members.ok && Array.isArray(members.value)) {
          for (const row of members.value) {
            if (!row || typeof row !== "object") continue;
            const rec = row as Record<string, unknown>;
            const id = typeof rec.personUid === "string" ? rec.personUid : "";
            if (!id) continue;
            labels[id] = {
              email: typeof rec.email === "string" ? rec.email : null,
              displayName: typeof rec.displayName === "string" ? rec.displayName : null,
            };
          }
        } else if (messaging) {
          const contacts = await messaging.listContacts();
          if (contacts.ok && Array.isArray(contacts.value)) {
            for (const row of contacts.value) {
              if (!row || typeof row !== "object") continue;
              const rec = row as Record<string, unknown>;
              const id = typeof rec.personUid === "string" ? rec.personUid : "";
              if (!id) continue;
              labels[id] = {
                email: typeof rec.email === "string" ? rec.email : null,
                displayName: typeof rec.displayName === "string" ? rec.displayName : null,
              };
            }
          }
        }
        if (cancelled) return;
        const next = normalizeCompanyTeamTelemetry(rawRes.value, { memberLabelsById: labels });
        const fromWire = pendingInvitesFromTelemetry(rawRes.value);
        view = next;
        if (fromWire.length > 0) invites = fromWire;
        phase = "ready";
        writeTeamCache(key, { view: next, invites });
      } catch (err) {
        if (cancelled) return;
        view = {
          ...emptyView,
          error: err instanceof Error ? err.message : "Could not read the team.",
        };
        phase = "ready";
      }
      void companyUid;
    })();
    return () => {
      cancelled = true;
    };
  });

  function remember(): void {
    writeTeamCache(slug, { view, invites });
  }

  function roleLine(member: TeamMember): string {
    return member.role?.trim() || (member.kind === "agent" ? "Member" : "Member");
  }

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return name.trim().slice(0, 2).toUpperCase() || "?";
  }

  function live(member: TeamMember): boolean {
    return Boolean(companyUid) && presenceStatus(companyUid!, member.id) === "online";
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
    <span class="chip" class:live={liveMembers > 0} data-testid="team-live-chip">
      <i class="ldot"></i>{liveMembers} live
    </span>
    <span class="chip" data-testid="team-seat-chip">{seatLine}</span>
    <button type="button" class="btn" data-testid="invite-teammate" onclick={() => (inviteOpen = true)}>
      Invite teammate
    </button>
    <button type="button" class="btn primary" data-testid="team-add-agent" onclick={() => onaddagent?.()}>
      Add agent
    </button>
  </div>

  <div class="canvas">
    {#if phase === "shimmer"}
      <div class="shimmer" data-testid="team-shimmer" aria-hidden="true">
        {#each [0, 1, 2, 3] as row (row)}
          <div class="shimmer-row"></div>
        {/each}
      </div>
    {:else}
      {#if view.error}
        <p class="note" role="alert">{view.error}</p>
      {/if}
      {#if showHumans}
        <div class="sech">Humans · {humans.length}</div>
        <table class="tbl">
          <thead>
            <tr><th>Member</th><th>Role</th><th>Working on</th><th class="r">Joined</th><th class="act"></th></tr>
          </thead>
          <tbody>
            {#each humans as member (member.id)}
              <tr>
                <td>
                  <span class="who">
                    <span class="mini">{initials(member.displayName)}<span class="ld" class:pulse={live(member)}></span></span>
                    <span>
                      <span class="nm">{member.displayName}</span>
                      {#if member.email}<span class="em">{member.email}</span>{/if}
                    </span>
                  </span>
                </td>
                <td>{roleLine(member)}</td>
                <td class="wk">{working(member)}</td>
                <td class="r">{member.joined ?? "—"}</td>
                <td class="act">{@render rowMenu(member, false)}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="em">No people yet.</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if showBots}
        <div class="sech">Bots · {bots.length}</div>
        <table class="tbl">
          <thead>
            <tr><th>Agent</th><th>Role</th><th>Working on</th><th class="r">Enrolled</th><th class="act"></th></tr>
          </thead>
          <tbody>
            {#each bots as member (member.id)}
              <tr>
                <td>
                  <span class="who">
                    <span class="mini sq">⌁<span class="ld" class:pulse={live(member)}></span></span>
                    <span class="nm">{member.displayName}</span>
                  </span>
                </td>
                <td>{roleLine(member)}</td>
                <td class="wk">{working(member)}</td>
                <td class="r">{member.joined ?? "—"}</td>
                <td class="act">{@render rowMenu(member, true)}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="em">No bots yet.</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      <div class="sech">Pending invites · {invites.length} waiting</div>
      <ul class="inv" data-testid="pending-invites">
        {#each invites as invite (invite.id)}
          <li>
            <div>
              <div class="nm">{invite.email}</div>
              <div class="em">{inviteSummary(invite)}</div>
            </div>
            <button
              type="button"
              class="btn"
              onclick={() => {
                invites = resendInvite(invites, invite.id);
                remember();
              }}>Resend</button>
            <button
              type="button"
              class="btn"
              data-testid={`revoke-${invite.id}`}
              onclick={() => (revokeId = invite.id)}>Revoke</button>
          </li>
        {:else}
          <li class="em">No pending invites.</li>
        {/each}
      </ul>
      <p class="note">Invites go through the request-access funnel. Recipients confirm their email and appear here until they sign in.</p>
    {/if}
  </div>

  {#if inviteOpen}
    <div class="scrim" data-testid="invite-sheet" data-scene="invite-teammate">
      <div class="sheet" role="dialog" aria-label="Invite teammate">
        <header class="sh">
          Invite teammate
          <button type="button" class="icon" aria-label="Close" onclick={() => (inviteOpen = false)}>✕</button>
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
          <button type="button" class="btn" onclick={() => (inviteOpen = false)}>Cancel</button>
          <button type="button" class="btn primary" data-testid="invite-send" onclick={submitInvite}>Send invite</button>
        </footer>
      </div>
    </div>
  {/if}
</section>

{#snippet rowMenu(member: TeamMember, bot: boolean)}
  <div class="menu-wrap">
    <button
      type="button"
      class="icon"
      aria-label={`Actions for ${member.displayName}`}
      aria-expanded={menuFor === member.id}
      data-testid={`team-menu-${member.id}`}
      onclick={() => (menuFor = menuFor === member.id ? null : member.id)}
    >…</button>
    {#if menuFor === member.id}
      <div class="menu" role="menu" data-testid="team-row-menu">
        <span class="menu-note">Change role</span>
        {#each ["Owner", "Admin", "Member"] as role (role)}
          <button type="button" role="menuitemradio" aria-checked={roleLine(member) === role} onclick={() => setRole(member, role)}>{role}</button>
        {/each}
        <button type="button" role="menuitem" data-testid={`team-remove-${member.id}`} onclick={() => (removeId = member.id)}>Remove</button>
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
  .team-page {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--v4-text-1);
    background: transparent;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-hairline);
  }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .tabs, .seg { display: inline-flex; gap: 2px; }
  .tab {
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    border-radius: 6px;
    padding: 3px 8px;
    font: inherit;
    font-size: 12px;
  }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .grow { flex: 1; }
  .btn {
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    border-radius: 6px;
    padding: 4px 10px;
    font: inherit;
    font-size: 12px;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .canvas { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px 24px; }
  .sech {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--v4-text-3);
    margin: 16px 0 8px;
  }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 400;
    color: var(--v4-text-3);
    text-align: left;
    padding: 0 12px 6px 0;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .tbl td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--v4-rowline); color: var(--v4-text-2); vertical-align: middle; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: 999px;
    color: var(--v4-text-2);
    font-size: 12px;
    white-space: nowrap;
  }
  .ldot, .ld {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-text-3);
  }
  .chip.live .ldot, .ld.pulse { background: var(--ok); }
  .who { display: flex; align-items: center; gap: 10px; }
  .mini {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font-size: 10px;
    font-weight: 600;
    flex: 0 0 28px;
  }
  .mini.sq { border-radius: 6px; }
  .mini .ld { position: absolute; right: -1px; bottom: -1px; box-shadow: 0 0 0 1.5px var(--v4-ground, #111); }
  .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .act { width: 36px; text-align: right; position: relative; }
  .menu-wrap { position: relative; display: inline-flex; }
  .menu {
    position: absolute;
    right: 0;
    top: 22px;
    z-index: 5;
    min-width: 140px;
    padding: 4px;
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover);
  }
  .menu button {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--v4-text-1);
    padding: 6px 8px;
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
  }
  .menu button:hover { background: var(--v4-active-row); }
  .menu-note { display: block; padding: 4px 8px; color: var(--v4-text-3); font-size: 11px; }
  .nm { color: var(--v4-text-1); display: block; }
  .em, .note, .wk { color: var(--v4-text-3); font-size: 12px; }
  .inv { list-style: none; margin: 0; padding: 0; }
  .inv li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--v4-rowline); }
  .inv li div { flex: 1; min-width: 0; }
  .shimmer-row {
    height: 28px;
    margin: 8px 0;
    border-radius: 6px;
    background: var(--v4-control-faint);
  }
  .scrim {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
    z-index: 20;
  }
  .team-page { position: relative; }
  .sheet {
    width: 480px;
    max-width: calc(100% - 32px);
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
  }
  .sh, .sf { display: flex; align-items: center; gap: 8px; padding: 0 16px; height: 52px; }
  .sh { border-bottom: 1px solid var(--v4-hairline); font-weight: 600; }
  .sf { border-top: 1px solid var(--v4-hairline); }
  .icon { margin-left: auto; border: 0; background: transparent; color: var(--v4-text-3); font: inherit; }
  .fr { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--v4-rowline); align-items: start; }
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
</style>
