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
  import { companyInviteUrl, companyTeamUrl } from '../lib/hq-console';
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
  let externalActionBusy = $state<'invite' | 'console' | null>(null);
  let externalActionError = $state<string | null>(null);
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

  async function openExternalDestination(
    destination: 'invite' | 'console',
    url: string,
  ): Promise<void> {
    if (externalActionBusy) return;
    externalActionBusy = destination;
    externalActionError = null;
    try {
      await openExternal(url);
    } catch (err) {
      console.error(`Open team ${destination} failed:`, err);
      externalActionError =
        destination === 'invite'
          ? 'Could not open invitations in the HQ console.'
          : 'Could not open the company team in the HQ console.';
    } finally {
      externalActionBusy = null;
    }
  }

  async function openInvite(): Promise<void> {
    await openExternalDestination('invite', companyInviteUrl(slug));
  }

  async function openConsole(): Promise<void> {
    // US-011: deep-link straight to the console team roster for management.
    await openExternalDestination('console', companyTeamUrl(slug));
  }

  function memberListMeta(member: TeamMember): string {
    const typeRole = memberTypeRoleLabel(member);
    const parts: string[] = [];
    if (member.email && member.email !== member.displayName) {
      parts.push(member.email);
    }
    if (typeRole !== memberKindLabel(member.kind)) {
      parts.push(typeRole);
    }
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
        onclick={() => void openInvite()}
        disabled={externalActionBusy !== null}
        aria-busy={externalActionBusy === 'invite'}
      >
        {externalActionBusy === 'invite' ? 'Opening…' : 'Invite'}
      </button>
      <button
        type="button"
        class="team-action-button secondary"
        data-testid="team-open-console"
        aria-label="Open company team roster in HQ console"
        onclick={() => void openConsole()}
        disabled={externalActionBusy !== null}
        aria-busy={externalActionBusy === 'console'}
      >
        {externalActionBusy === 'console' ? 'Opening…' : 'Open console'}
      </button>
    </div>
  </header>

  {#if externalActionError}
    <p class="team-error" role="alert" data-testid="team-action-error">
      {externalActionError}
    </p>
  {/if}

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
                {#if selectedMember.email && selectedMember.email !== selectedMember.displayName}
                  <span class="team-detail-email" data-testid="team-detail-email">
                    {selectedMember.email}
                  </span>
                {/if}
                <span class="team-detail-meta" data-testid="team-detail-meta">
                  Activity summary · last 30 days
                </span>
              </div>
            </header>

            <dl class="team-member-facts" data-testid="team-member-facts">
              <div>
                <dt>Type & role</dt>
                <dd>{memberTypeRoleLabel(selectedMember)}</dd>
              </div>
              <div>
                <dt>Sessions</dt>
                <dd>{selectedMember.sessions ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd>{selectedMember.events ?? 'Unavailable'}</dd>
              </div>
            </dl>

            <div class="team-section-grid">
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
            </div>
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
    min-height: clamp(360px, calc(100dvh - 170px), 620px);
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

  .team-action-button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .team-action-button:focus-visible,
  .team-member-row:focus-visible,
  .team-detail-back:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  /* DESKTOP-009: naked canvas, hairline list/detail split — no rounded outer shell. */
  .team-workspace {
    display: grid;
    grid-template-columns: minmax(280px, 34%) minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    border: 0;
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
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--v4-hairline);
    color: var(--v4-text-1);
    border-radius: 0;
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
    gap: var(--v4-space-5, 20px);
    min-width: 0;
    min-height: 0;
    height: 100%;
    padding: 12px 18px 20px;
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

  .team-detail-email,
  .team-detail-meta {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    font-weight: 400;
    line-height: 1.3;
  }

  .team-detail-email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .team-member-facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0;
    margin: 0;
    padding: 12px 0;
    border-top: 1px solid var(--v4-rowline);
    border-bottom: 1px solid var(--v4-rowline);
  }

  .team-member-facts div {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    padding: 0 14px;
  }

  .team-member-facts div:first-child {
    padding-left: 0;
  }

  .team-member-facts div + div {
    border-left: 1px solid var(--v4-rowline);
  }

  .team-member-facts dt,
  .team-member-facts dd {
    overflow: hidden;
    margin: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .team-member-facts dt {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 13px);
  }

  .team-member-facts dd {
    color: var(--v4-text-1);
    font-size: var(--type-body, 15px);
    font-variant-numeric: tabular-nums;
  }

  .team-section-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 28px;
    min-width: 0;
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
    display: grid;
    gap: 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .skill-chip,
  .project-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    padding: 8px 0;
    border: 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 14px);
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
    padding: 10px 0;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
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
    border: 0;
    border-radius: 0;
    background: transparent;
    text-align: center;
  }

  .team-detail-empty {
    height: 100%;
    align-content: center;
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
    .team-workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .team-workspace[data-detail-open='true'] .team-detail-back {
      display: inline-flex;
      align-items: center;
    }

    .team-workspace[data-detail-open='false'] .team-detail-pane {
      display: none;
    }
  }

  @media (max-width: 720px) {
    .team-panel {
      /* The desktop keeps its 220px global sidebar at compact widths and the
         page canvas contributes 18px padding on each side. Some parent panels
         retain their wide intrinsic size, so explicitly cap Team to the
         actually visible company canvas instead of letting its controls render
         beyond the clipped viewport. */
      inline-size: calc(100dvw - 256px);
      max-inline-size: 100%;
    }

    .team-header {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
    }

    .team-heading {
      width: 100%;
    }

    .team-meta {
      overflow: visible;
      overflow-wrap: anywhere;
      text-overflow: clip;
      white-space: normal;
    }

    .team-actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      min-width: 0;
      width: 100%;
    }

    .team-actions .team-action-button {
      width: 100%;
      min-width: 0;
      height: auto;
      min-height: 30px;
      padding: 6px 10px;
      line-height: 1.2;
      overflow-wrap: anywhere;
      white-space: normal;
    }

    .team-detail-title-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 4px;
    }

    .team-detail-title-row h3,
    .team-detail-email,
    .team-detail-meta {
      overflow: visible;
      overflow-wrap: anywhere;
      text-overflow: clip;
      white-space: normal;
    }

    .team-member-facts,
    .team-section-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .team-member-facts div {
      padding: 8px 0;
    }

    .team-member-facts div:first-child {
      padding-top: 0;
    }

    .team-member-facts div + div {
      border-top: 1px solid var(--v4-rowline);
      border-left: 0;
    }

    .team-member-facts dt,
    .team-member-facts dd {
      overflow: visible;
      overflow-wrap: anywhere;
      text-overflow: clip;
      white-space: normal;
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

    .team-member-row:hover {
      background: var(--v4-control-faint, rgba(0, 0, 0, 0.06));
    }

    .team-member-row.is-selected {
      background: transparent;
    }
  }
</style>
