<script lang="ts">
  /**
   * Create project-channel sheet (US-005).
   *
   * Picks a local project, defaults the channel name, invites humans via
   * RecipientPicker, and auto-includes agents assigned to / running on the
   * project. Creates via `create_channel` with scope='project'.
   *
   * UI: monochrome, weight ≤ 500, no rounded cards (match ChatSidebar).
   */
  import { invoke } from '@tauri-apps/api/core';
  import RecipientPicker from '../../components/messaging/RecipientPicker.svelte';
  import type { SelectedRecipient } from '../../lib/recipientPicker';
  import type { Channel } from '../../lib/channels';
  import type { Workspace } from '../../lib/workspaces';
  import { loadLocalProjects } from '../lib/local-projects';
  import { presentPanelError } from '../lib/panel-error';
  import type { Project } from '../lib/projects-model';
  import type { MissionControlSnapshot } from '../lib/sessions';
  import {
    agentsForProject,
    buildCreateProjectChannelPayload,
    defaultChannelNameFromProject,
    filterProjectPickerRows,
    resolveCompanyUidForProject,
    toProjectPickerRow,
    type ProjectAgentInvite,
    type ProjectPickerRow,
  } from './project-channel-model';

  interface Props {
    onclose: () => void;
    oncreated: (channel: Channel) => void;
    companies?: Workspace[] | null;
  }

  let { onclose, oncreated, companies = null }: Props = $props();

  type Step = 'pick' | 'configure';

  let step = $state<Step>('pick');
  let projects = $state<Project[]>([]);
  let pickerRows = $state<ProjectPickerRow[]>([]);
  let projectsLoading = $state(true);
  let projectsError = $state<string | null>(null);
  let query = $state('');

  let selectedProject = $state<Project | null>(null);
  let name = $state('');
  let companyUid = $state<string | null>(null);
  let companyLabel = $state<string>('');

  let invitePick = $state<SelectedRecipient | null>(null);
  let humanInvites = $state<SelectedRecipient[]>([]);
  let agentInvites = $state<ProjectAgentInvite[]>([]);

  let creating = $state(false);
  let createError = $state<string | null>(null);

  const filteredRows = $derived(filterProjectPickerRows(pickerRows, query));
  const canCreate = $derived(
    !creating &&
      !!selectedProject &&
      !!companyUid &&
      name.trim().length > 0,
  );

  async function loadProjects(): Promise<void> {
    projectsLoading = true;
    projectsError = null;
    try {
      const list = await loadLocalProjects();
      projects = list;
      pickerRows = list.map(toProjectPickerRow);
    } catch (err) {
      projectsError = presentPanelError(err, {
        surface: 'local projects',
        fallback: 'Could not load local projects',
      }).message;
      console.error('create-project-channel: get_local_projects failed', err);
    } finally {
      projectsLoading = false;
    }
  }

  async function loadAgentsFor(project: Project): Promise<void> {
    try {
      const snap = await invoke<MissionControlSnapshot>('list_agent_sessions');
      const sessions = (snap?.sessions ?? []).map((s) => ({
        project: s.project,
        company: s.company,
        cwd: s.cwd,
        status: s.status,
        tool: s.tool,
        model: s.model,
        source: s.source,
      }));
      agentInvites = agentsForProject(project, sessions, []);
    } catch (err) {
      console.error('create-project-channel: list_agent_sessions failed', err);
      agentInvites = [];
    }
  }

  function selectProject(row: ProjectPickerRow): void {
    const project = projects.find((p) => p.id === row.id && p.company === row.company);
    if (!project) return;
    selectedProject = project;
    name = defaultChannelNameFromProject(project);
    const uid = resolveCompanyUidForProject(project.company, companies ?? []);
    companyUid = uid;
    companyLabel =
      (companies ?? []).find((w) => w.cloudUid === uid)?.displayName?.trim() ||
      project.company ||
      'Company';
    step = 'configure';
    void loadAgentsFor(project);
  }

  function addInvite(r: SelectedRecipient | null): void {
    if (!r) return;
    const uid = r.personUid?.trim();
    if (!uid) return;
    if (humanInvites.some((i) => i.personUid === uid)) {
      invitePick = null;
      return;
    }
    humanInvites = [...humanInvites, r];
    invitePick = null;
  }

  function removeHuman(uid: string | undefined): void {
    humanInvites = humanInvites.filter((i) => i.personUid !== uid);
  }

  function inviteLabel(r: SelectedRecipient): string {
    return r.displayName?.trim() || r.email;
  }

  async function create(): Promise<void> {
    if (!canCreate || !selectedProject || !companyUid) return;
    const payload = buildCreateProjectChannelPayload({
      name,
      projectId: selectedProject.id,
      companyUid,
      humanInviteUids: humanInvites
        .map((i) => i.personUid)
        .filter((u): u is string => !!u),
      agentInviteUids: agentInvites.map((a) => a.personUid),
    });
    if (!payload) return;
    creating = true;
    createError = null;
    try {
      const channel = await invoke<Channel>('create_channel', {
        name: payload.name,
        scope: payload.scope,
        companyUid: payload.companyUid,
        projectId: payload.projectId,
        invite: payload.invite,
      });
      oncreated(channel);
    } catch (err) {
      createError = typeof err === 'string' ? err : 'Could not create the project channel';
      console.error('create-project-channel: create failed', err);
    } finally {
      creating = false;
    }
  }

  function requestClose(): void {
    if (!creating) onclose();
  }

  function backToPicker(): void {
    if (creating) return;
    step = 'pick';
    selectedProject = null;
    createError = null;
  }

  $effect(() => {
    void loadProjects();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="pc-backdrop"
  data-testid="create-project-channel"
  onclick={(e) => {
    if (e.target === e.currentTarget) requestClose();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') requestClose();
  }}
  role="presentation"
>
  <div
    class="pc-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="New project channel"
    aria-busy={creating}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <header class="pc-header">
      <h2>{step === 'pick' ? 'Project channel' : 'Configure channel'}</h2>
      <button
        class="pc-text-btn"
        type="button"
        onclick={requestClose}
        aria-label="Close"
        disabled={creating}
      >Close</button>
    </header>

    {#if step === 'pick'}
      <p class="pc-hint">Pick a local project. The channel is invite-only.</p>
      <input
        class="pc-input"
        type="search"
        placeholder="Filter projects"
        bind:value={query}
        aria-label="Filter projects"
        disabled={projectsLoading}
      />
      <div class="pc-list" role="list" data-testid="project-channel-picker">
        {#if projectsLoading}
          <div class="pc-empty" role="status">Loading projects…</div>
        {:else if projectsError}
          <div class="pc-empty" role="alert">
            <span>{projectsError}</span>
            <button class="pc-text-btn" type="button" onclick={() => void loadProjects()}>
              Retry
            </button>
          </div>
        {:else if filteredRows.length === 0}
          <div class="pc-empty">No local projects</div>
        {:else}
          {#each filteredRows as row (row.company + ':' + row.id + ':' + row.prdPath)}
            <div role="listitem" class="pc-li">
            <button
              type="button"
              class="pc-row"
              onclick={() => selectProject(row)}
            >
              <span class="pc-glyph" aria-hidden="true">#</span>
              <span class="pc-row-copy">
                <span class="pc-row-title">{row.title}</span>
                <span class="pc-row-sub">{row.subtitle}</span>
              </span>
            </button>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <button class="pc-text-btn back" type="button" onclick={backToPicker} disabled={creating}>
        Back to projects
      </button>

      {#if !companyUid}
        <p class="pc-alert" role="alert">
          {companyLabel || 'This company'} is not cloud-linked on this Mac — a project channel needs
          a company membership.
        </p>
      {/if}

      <label class="pc-field">
        <span class="pc-label">Name</span>
        <div class="pc-name-wrap">
          <span class="pc-glyph" aria-hidden="true">#</span>
          <input
            class="pc-input bare"
            type="text"
            bind:value={name}
            autocomplete="off"
            spellcheck="false"
            disabled={creating}
            aria-label="Channel name"
          />
        </div>
      </label>

      <div class="pc-meta">
        <span>{companyLabel}</span>
        <span aria-hidden="true">·</span>
        <span>project channel</span>
      </div>

      <div class="pc-field">
        <span class="pc-label">Invite people <span class="pc-optional">(optional)</span></span>
        <RecipientPicker
          bind:selected={invitePick}
          onselect={(r) => addInvite(r)}
          placeholder="Add someone…"
          disabled={creating}
        />
        {#if humanInvites.length > 0}
          <ul class="pc-chips">
            {#each humanInvites as i (i.personUid)}
              <li class="pc-chip">
                <span>{inviteLabel(i)}</span>
                <button
                  type="button"
                  class="pc-chip-x"
                  onclick={() => removeHuman(i.personUid)}
                  aria-label={`Remove ${inviteLabel(i)}`}
                  disabled={creating}
                >×</button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if agentInvites.length > 0}
        <div class="pc-field" data-testid="project-channel-agents">
          <span class="pc-label">Agents on project</span>
          <p class="pc-hint">Added as invite-only participants.</p>
          <ul class="pc-agent-list">
            {#each agentInvites as a (a.personUid)}
              <li class="pc-agent-row">
                <span
                  class="pc-status-dot"
                  class:running={a.status === 'running' || a.status === 'awaiting_input'}
                  aria-hidden="true"
                ></span>
                <span class="pc-agent-name">{a.displayName}</span>
                <span class="pc-agent-status">{a.status}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class="pc-footer">
        {#if createError}
          <span class="pc-alert" role="alert">{createError}</span>
        {/if}
        <button
          class="pc-create"
          type="button"
          onclick={() => void create()}
          disabled={!canCreate}
          aria-busy={creating}
          data-testid="project-channel-create"
        >
          {creating ? 'Creating…' : 'Create channel'}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .pc-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 3.5rem 1.5rem 1.5rem;
    background: color-mix(in srgb, var(--v4-ground, #111) 48%, transparent);
  }

  .pc-sheet {
    width: 100%;
    max-width: 420px;
    max-height: min(80vh, 640px);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem 1rem 1rem;
    border: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: 0;
    background: var(--v4-chrome, var(--pop-bg));
    color: var(--v4-text-1, var(--pop-text));
    font-family: var(--font-sans);
    overflow: hidden;
  }

  .pc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .pc-header h2 {
    margin: 0;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .pc-text-btn {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--v4-text-2, var(--pop-muted));
    font: inherit;
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    cursor: pointer;
    padding: 0.125rem 0;
  }

  .pc-text-btn:hover {
    color: var(--v4-text-1, var(--pop-text));
  }

  .pc-text-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .pc-text-btn.back {
    align-self: flex-start;
  }

  .pc-hint {
    margin: 0;
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    color: var(--v4-text-2, var(--pop-muted));
  }

  .pc-input {
    width: 100%;
    box-sizing: border-box;
    height: 32px;
    padding: 0 0.5rem;
    border: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: 0;
    background: var(--v4-control-faint, transparent);
    color: inherit;
    font: inherit;
    font-size: var(--text-base, 13px);
    font-weight: 400;
  }

  .pc-input.bare {
    border: none;
    background: transparent;
    height: auto;
    padding: 0.375rem 0;
  }

  .pc-input:focus {
    outline: none;
    border-color: var(--v4-text-2, var(--pop-muted));
  }

  .pc-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    border-top: 1px solid var(--v4-hairline, var(--pop-border));
  }

  .pc-li {
    display: contents;
  }

  .pc-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.25rem;
    border: none;
    border-bottom: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .pc-row:hover {
    background: var(--v4-active-row, var(--pop-hover));
  }

  .pc-glyph {
    color: var(--v4-text-2, var(--pop-muted));
    font-weight: 500;
  }

  .pc-row-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.0625rem;
  }

  .pc-row-title {
    font-size: var(--text-base, 13px);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pc-row-sub {
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    color: var(--v4-text-2, var(--pop-muted));
  }

  .pc-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 1rem 0.25rem;
    color: var(--v4-text-2, var(--pop-muted));
    font-size: var(--type-metadata, 12px);
  }

  .pc-field {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }

  .pc-label {
    font-size: var(--type-metadata, 12px);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-2, var(--pop-muted));
  }

  .pc-optional {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .pc-name-wrap {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: 0;
    padding: 0 0.5rem;
    background: var(--v4-control-faint, transparent);
  }

  .pc-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    color: var(--v4-text-2, var(--pop-muted));
  }

  .pc-chips {
    list-style: none;
    margin: 0.125rem 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .pc-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.375rem;
    border: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: 0;
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
  }

  .pc-chip-x {
    border: none;
    background: transparent;
    color: var(--v4-text-2, var(--pop-muted));
    font: inherit;
    cursor: pointer;
    padding: 0 0.125rem;
    line-height: 1;
  }

  .pc-agent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .pc-agent-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--v4-hairline, var(--pop-border));
    font-size: var(--type-metadata, 12px);
  }

  .pc-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-text-2, var(--pop-muted));
    flex-shrink: 0;
  }

  .pc-status-dot.running {
    background: var(--v4-ok, #6a6);
  }

  .pc-agent-name {
    flex: 1;
    min-width: 0;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pc-agent-status {
    color: var(--v4-text-2, var(--pop-muted));
    font-weight: 400;
  }

  .pc-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }

  .pc-create {
    margin-left: auto;
    appearance: none;
    border: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: 0;
    background: var(--v4-control-faint, transparent);
    color: var(--v4-text-1, var(--pop-text));
    font: inherit;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    padding: 0.4375rem 0.875rem;
    cursor: pointer;
  }

  .pc-create:hover:not(:disabled) {
    background: var(--v4-active-row, var(--pop-hover));
  }

  .pc-create:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .pc-alert {
    margin: 0;
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    color: var(--v4-text-1, var(--pop-text));
  }
</style>
