<script lang="ts">
  /**
   * TeamPanel — company Team tab: mixed humans + agents list/detail (DESKTOP-009).
   *
   * One scan-friendly workspace (not People/Humans/Agents tabs). Type/role
   * labels are honest (Human / Agent, or payload role when present). Top skills
   * and active projects show only when real data exists. Invite + Open console
   * are the supported path; desktop does not mutate membership, roles, or ACL.
   *
   * Loads via Tauri `get_company_team_telemetry` (hq-pro company telemetry).
   * Tenant isolation: command resolves slug → companyUid server-side.
   */
  import { invoke } from '@tauri-apps/api/core';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { companyConsoleUrl, companyInviteUrl } from '../lib/hq-console';
  import {
    defaultTelemetryRange,
    memberKindLabel,
    memberTypeRoleLabel,
    normalizeCompanyTeamTelemetry,
    teamTelemetryErrorMessage,
    type TeamMember,
    type TeamTelemetryView,
  } from '../lib/team-telemetry';
  import '../v4/tokens.css';

  interface Props {
    slug: string;
    companyUid?: string | null;
  }

  interface ContactRow {
    personUid: string;
    email?: string | null;
    displayName?: string | null;
  }

  interface ContactsResponse {
    contacts: ContactRow[];
  }

  let { slug, companyUid = null }: Props = $props();

  let loading = $state(true);
  let view = $state<TeamTelemetryView>({
    members: [],
    humans: [],
    agents: [],
    error: null,
    empty: true,
  });
  /** Stable selected member in the list/detail workspace. */
  let selectedMemberId = $state<string | null>(null);

  const selectedMember = $derived.by(() => {
    if (!selectedMemberId) return null;
    return view.members.find((m) => m.id === selectedMemberId) ?? null;
  });

  const humanCount = $derived(view.humans.length);
  const agentCount = $derived(view.agents.length);

  $effect(() => {
    const activeSlug = slug;
    const activeCompanyUid = companyUid;
    loading = true;
    selectedMemberId = null;
    view = { members: [], humans: [], agents: [], error: null, empty: true };
    if (!activeSlug) {
      loading = false;
      return;
    }

    let cancelled = false;
    const range = defaultTelemetryRange(30);

    void (async () => {
      try {
        const [raw, contactResponse] = await Promise.all([
          invoke<unknown>('get_company_team_telemetry', {
            slug: activeSlug,
            from: range.from,
            to: range.to,
          }),
          activeCompanyUid
            ? invoke<ContactsResponse>('list_company_members', {
                companyUid: activeCompanyUid,
              }).catch(() => ({ contacts: [] }))
            : invoke<ContactsResponse>('list_contacts').catch(() => ({ contacts: [] })),
        ]);
        if (cancelled) return;
        const memberLabelsById = Object.fromEntries(
          (contactResponse.contacts ?? []).map((contact) => [
            contact.personUid,
            { email: contact.email, displayName: contact.displayName },
          ]),
        );
        const next = normalizeCompanyTeamTelemetry(raw, { memberLabelsById });
        view = next;
        // Stable detail: auto-select the first ranked member when data loads.
        if (next.members.length > 0) {
          selectedMemberId = next.members[0].id;
        }
      } catch (err) {
        if (cancelled) return;
        console.error('get_company_team_telemetry failed:', err);
        view = {
          members: [],
          humans: [],
          agents: [],
          error: teamTelemetryErrorMessage(err),
          empty: true,
        };
        selectedMemberId = null;
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  function selectMember(member: TeamMember): void {
    selectedMemberId = member.id;
  }

  function clearMemberSelection(): void {
    // Narrow collapse: return to the full-width list without losing data.
    selectedMemberId = null;
  }

  function openInvite(): void {
    void openExternal(companyInviteUrl(slug));
  }

  function openConsole(): void {
    void openExternal(companyConsoleUrl(slug));
  }

  function memberListMeta(member: TeamMember): string {
    const typeRole = memberTypeRoleLabel(member);
    const parts: string[] = [typeRole];
    if (member.sessions != null) {
      parts.push(`${member.sessions} ${member.sessions === 1 ? 'session' : 'sessions'}`);
    }
    if (member.events != null) {
      parts.push(`${member.events} ${member.events === 1 ? 'event' : 'events'}`);
    }
    if (member.topSkills.length > 0) {
      parts.push(member.topSkills[0].skill);
    }
    return parts.join(' · ');
  }

  function activitySummary(member: TeamMember): string | null {
    const parts: string[] = [];
    if (member.sessions != null) {
      parts.push(`${member.sessions} ${member.sessions === 1 ? 'session' : 'sessions'}`);
    }
    if (member.events != null) {
      parts.push(`${member.events} ${member.events === 1 ? 'event' : 'events'}`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  /**
   * Keyboard selection in the team list: ArrowUp/Down move selection,
   * Home/End jump. Selection stays stable in the detail pane.
   */
  function handleListKeydown(event: KeyboardEvent): void {
    if (view.members.length === 0) return;
    const keys = view.members.map((m) => m.id);
    const index = selectedMemberId ? keys.indexOf(selectedMemberId) : -1;

    let nextIndex = index;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nextIndex = Math.min(view.members.length - 1, Math.max(0, index) + (index < 0 ? 0 : 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nextIndex = Math.max(0, index < 0 ? 0 : index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      nextIndex = view.members.length - 1;
    } else if (event.key === 'Escape' && selectedMemberId) {
      event.preventDefault();
      clearMemberSelection();
      return;
    } else {
      return;
    }

    const next = view.members[nextIndex];
    if (!next) return;
    if (next.id !== selectedMemberId) {
      selectedMemberId = next.id;
    }
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="team-member-row"][data-member-id="${CSS.escape(next.id)}"]`,
      );
      el?.focus();
    });
  }
</script>

<section
  class="team-panel"
  aria-label="Team"
  data-testid="company-team-panel"
>
  <header class="team-header">
    <div class="team-heading title-stack">
      <h2>Team</h2>
      <span class="team-meta" data-testid="team-scope-meta">
        Last 30 days · {humanCount} {humanCount === 1 ? 'human' : 'humans'} · {agentCount}
        {agentCount === 1 ? 'agent' : 'agents'}
      </span>
    </div>
    <div class="team-actions detail-primary-actions primary-actions" data-testid="team-primary-actions">
      <button
        type="button"
        class="team-action-button"
        data-testid="team-invite"
        aria-label="Invite teammate in HQ console"
        onclick={openInvite}
      >
        Invite
      </button>
      <button
        type="button"
        class="team-action-button secondary"
        data-testid="team-open-console"
        aria-label="Open company team in HQ console"
        onclick={openConsole}
      >
        Open console
      </button>
    </div>
  </header>

  {#if loading}
    <p class="team-status" data-testid="team-loading" aria-busy="true">Loading team…</p>
  {:else if view.error}
    <p class="team-error" role="alert" data-testid="team-error">{view.error}</p>
  {:else if view.empty}
    <div class="team-empty" data-testid="team-empty">
      <span class="team-empty-title">No team telemetry yet</span>
      <p class="team-empty-meta">
        Usage appears after members work with HQ. Invite teammates from the console when ready.
      </p>
    </div>
  {:else}
    <!-- DESKTOP-009: mixed humans+agents list + stable selected-member detail. -->
    <div
      class="list-detail team-workspace"
      data-testid="team-workspace"
      data-detail-open={selectedMember != null ? 'true' : 'false'}
    >
      <aside class="list-pane team-list-pane" data-testid="team-list-pane">
        <div
          class="team-list"
          role="listbox"
          tabindex="-1"
          aria-label="Team members"
          data-testid="team-list"
          onkeydown={handleListKeydown}
        >
          {#each view.members as member (member.id)}
            {@const isSelected = selectedMemberId === member.id}
            {@const kindLabel = memberKindLabel(member.kind)}
            <button
              type="button"
              class="team-member-row"
              class:is-selected={isSelected}
              role="option"
              aria-selected={isSelected}
              tabindex={isSelected ? 0 : -1}
              data-testid="team-member-row"
              data-member-id={member.id}
              data-kind={member.kind}
              aria-label={`${member.displayName}, ${kindLabel}`}
              onclick={() => selectMember(member)}
            >
              <span class="member-row-copy title-stack">
                <span class="member-row-title">{member.displayName}</span>
                <span class="member-row-meta">{memberListMeta(member)}</span>
              </span>
              <span class="kind-badge" data-testid="team-kind-badge">{kindLabel}</span>
            </button>
          {/each}
        </div>
      </aside>

      <div class="detail-pane team-detail-pane" data-testid="team-detail-pane">
        {#if selectedMember}
          <article
            class="team-detail"
            data-testid="team-detail"
            data-kind={selectedMember.kind}
            aria-labelledby="team-detail-title"
          >
            <header class="team-detail-header">
              <button
                type="button"
                class="team-detail-back"
                data-testid="team-detail-back"
                aria-label="Back to team list"
                onclick={clearMemberSelection}
              >
                Team
              </button>
              <div class="team-detail-heading title-stack">
                <div class="team-detail-title-row">
                  <h3 id="team-detail-title" data-testid="team-detail-title">
                    {selectedMember.displayName}
                  </h3>
                  <span class="kind-badge" data-testid="team-detail-kind">
                    {memberKindLabel(selectedMember.kind)}
                  </span>
                </div>
                <span class="team-detail-meta" data-testid="team-detail-meta">
                  {memberTypeRoleLabel(selectedMember)}
                  {#if activitySummary(selectedMember)}
                    · {activitySummary(selectedMember)}
                  {/if}
                </span>
              </div>
            </header>

            {#if selectedMember.topSkills.length > 0}
              <section class="team-section" aria-label="Top skills" data-testid="team-member-skills">
                <h4 class="section-label">Top skills</h4>
                <div class="chip-row">
                  {#each selectedMember.topSkills as skill (skill.skill)}
                    <span class="skill-chip" data-testid="team-skill-chip">
                      {skill.skill}
                      <span class="skill-n">{skill.count}</span>
                    </span>
                  {/each}
                </div>
              </section>
            {/if}

            {#if selectedMember.activeProjects.length > 0}
              <section
                class="team-section"
                aria-label="Active projects"
                data-testid="team-member-projects"
              >
                <h4 class="section-label">Active projects</h4>
                <div class="chip-row">
                  {#each selectedMember.activeProjects as project (project)}
                    <span class="project-chip" data-testid="team-project-chip">{project}</span>
                  {/each}
                </div>
              </section>
            {/if}

            {#if selectedMember.topSkills.length === 0 && selectedMember.activeProjects.length === 0}
              <p class="team-status subtle" data-testid="team-detail-no-activity">
                No skill usage or active projects recorded in this window.
              </p>
            {/if}
          </article>
        {:else}
          <div class="team-detail-empty" data-testid="team-detail-empty">
            <span class="team-empty-title">Select a teammate</span>
            <p class="team-empty-meta">
              Humans and agents share one list. Open a row for skills and projects from real
              telemetry.
            </p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .team-panel {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
    min-height: 0;
    height: 100%;
    font-family: var(--font-sans);
    background: transparent;
  }

  .team-header {
    display: flex;
    flex: 0 0 auto;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
  }

  .team-heading {
    display: grid;
    min-width: 0;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .team-heading h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-section, 14px);
    font-weight: 600;
    line-height: 1.2;
  }

  .team-meta {
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .team-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
  }

  .team-action-button {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 30px;
    cursor: pointer;
  }

  .team-action-button.secondary {
    border: 1px solid var(--v4-hairline);
    background: transparent;
    color: var(--v4-text-1);
  }

  .team-action-button:focus-visible,
  .team-member-row:focus-visible,
  .team-detail-back:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  /* DESKTOP-009: naked canvas, hairline list/detail split — no rounded outer shell. */
  .team-workspace {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    overflow: hidden;
  }

  .team-list-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--v4-hairline);
    background: transparent;
  }

  .team-list {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 0;
  }

  .team-member-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 10px 12px;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, 12px);
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  .team-member-row:first-child {
    border-top: 0;
  }

  .team-member-row:hover {
    background: var(--v4-active-row);
  }

  .team-member-row.is-selected {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
    border-radius: 6px;
  }

  .member-row-copy {
    min-width: 0;
  }

  .member-row-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-row-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kind-badge {
    flex: 0 0 auto;
    font-size: var(--type-metadata, 10px);
    color: var(--v4-text-3);
    padding: 2px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    line-height: 1.25;
  }

  .team-detail-pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: transparent;
  }

  .team-detail {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
    min-height: 0;
    height: 100%;
    padding: var(--v4-space-4, 16px);
    overflow-y: auto;
    background: transparent;
  }

  .team-detail-header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .team-detail-back {
    display: none;
    flex: 0 0 auto;
    align-self: flex-start;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, 11px);
    font-weight: 500;
    cursor: pointer;
  }

  .team-detail-heading {
    min-width: 0;
  }

  .team-detail-title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .team-detail-title-row h3 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-detail, 18px);
    font-weight: 600;
    line-height: 1.2;
  }

  .team-detail-meta {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    font-weight: 400;
    line-height: 1.3;
  }

  .team-section {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .section-label {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .skill-chip,
  .project-chip {
    font-size: var(--type-secondary, 11px);
    color: var(--v4-text-2);
    padding: 2px 8px;
    background: var(--v4-raised, rgba(255, 255, 255, 0.03));
    border-radius: 6px;
    border: 1px solid var(--v4-hairline);
  }

  .skill-n {
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
    margin-left: 4px;
  }

  .team-status {
    margin: 0;
    font-size: var(--type-body, 12px);
    color: var(--v4-text-2);
  }

  .team-status.subtle {
    font-size: var(--type-secondary, 11px);
    color: var(--v4-text-3);
  }

  .team-error {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--v4-error, #f87171);
    border-radius: 0;
    background: transparent;
    font-size: var(--type-body, 12px);
    color: var(--v4-error, #f87171);
  }

  .team-empty,
  .team-detail-empty {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    justify-items: center;
    padding: 28px 20px;
    border: 1px dashed var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    text-align: center;
  }

  .team-detail-empty {
    height: 100%;
    align-content: center;
    border: 0;
  }

  .team-empty-title {
    color: var(--v4-text-2);
    font-size: var(--type-body, 12px);
    font-weight: 500;
  }

  .team-empty-meta {
    margin: 0;
    max-width: 36ch;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 1.35;
  }

  @media (max-width: 820px) {
    /* When detail is open, shared .list-detail hides the list pane.
       Surface a back control so the list remains reachable. */
    .team-workspace[data-detail-open='true'] .team-detail-back {
      display: inline-flex;
      align-items: center;
    }
  }

  @media (max-width: 720px) {
    .team-header {
      align-items: stretch;
      flex-direction: column;
    }

    .team-actions,
    .team-action-button {
      width: 100%;
    }

    .team-detail-title-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 4px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .team-member-row {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .team-workspace,
    .team-list-pane,
    .team-detail-pane,
    .skill-chip,
    .project-chip {
      background: var(--v4-bg, #fff);
    }

    .team-member-row.is-selected,
    .team-member-row:hover {
      background: var(--v4-control-faint, rgba(0, 0, 0, 0.06));
    }
  }
</style>
