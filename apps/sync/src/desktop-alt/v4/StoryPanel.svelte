<script lang="ts">
  /**
   * StoryPanel — stable in-workspace task detail (DESKTOP-006).
   *
   * Docks inside the project workspace with a compact task rail; never a modal
   * or dimmed backdrop. Preserves task ID, title, task-level status, priority,
   * description, acceptance criteria, dependencies, labels, notes, files, and
   * agent activity when those fields exist.
   *
   * Acceptance criteria are a read-only group driven by the story-level
   * `passes` flag — no independent per-criterion checkboxes or invented state.
   * Live agent activity uses only real matched sessions (storyLiveRunView).
   * File rows keep Open in Claude Code (+ copy fallback).
   */
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { setStoryPasses } from '../lib/projects-store.svelte';
  import {
    projectDisplayName,
    storyLiveRunView,
    type PortfolioSessionRef,
    type Project,
    type Story,
  } from '../lib/projects-model';
  import { relativeActivity } from '../lib/sessions';
  import LabelChip from '../components/LabelChip.svelte';
  import OpenFileInClaudeCode from '../components/OpenFileInClaudeCode.svelte';
  import './tokens.css';

  interface Props {
    story: Story | null;
    project: Project | null;
    prdPath: string;
    onclose: () => void;
    onselectDependency?: (storyId: string) => void;
    onStoryPassesChange?: (storyId: string, passes: boolean) => void;
    /**
     * When true (project workspace default), render as a docked in-workspace
     * panel with no dimmed modal backdrop.
     */
    embedded?: boolean;
    /** Live sessions for honest agent-activity (real matches only). */
    sessions?: readonly PortfolioSessionRef[];
    /** Compact relative "now" for elapsed / last-signal labels. */
    now?: number;
  }

  let {
    story,
    project,
    prdPath,
    onclose,
    onselectDependency,
    onStoryPassesChange,
    embedded = true,
    sessions = [],
    now = Date.now(),
  }: Props = $props();

  let passesOverride = $state<boolean | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let footerBusy = $state<'prd' | 'run' | 'copy' | null>(null);
  let footerMessage = $state<string | null>(null);
  let hqFolderPath = $state('');

  $effect(() => {
    void story?.id;
    void story?.passes;
    passesOverride = null;
    error = null;
    footerBusy = null;
    footerMessage = null;
    saving = false;
  });

  $effect(() => {
    let cancelled = false;
    void invoke<{ hqFolderPath?: string }>('get_config')
      .then((config) => {
        if (!cancelled) hqFolderPath = config?.hqFolderPath ?? '';
      })
      .catch((err) => {
        console.error('StoryPanel get_config failed:', err);
        if (!cancelled) hqFolderPath = '';
      });
    return () => {
      cancelled = true;
    };
  });

  const currentPasses = $derived(passesOverride ?? story?.passes ?? false);
  const acItems = $derived(story?.acceptanceCriteria ?? []);
  const acComplete = $derived(currentPasses ? acItems.length : 0);
  const progress = $derived(acItems.length > 0 ? (acComplete / acItems.length) * 100 : 0);
  const priority = $derived(typeof story?.priority === 'number' ? `P${story.priority}` : null);
  const hierarchy = $derived(
    project && story ? `${projectDisplayName(project)} / ${story.id}` : '',
  );
  const files = $derived(story?.files ?? []);
  const deps = $derived(story?.dependsOn ?? []);
  const labels = $derived(story?.labels ?? []);
  const notes = $derived((story?.notes ?? '').trim());
  const liveRun = $derived(
    story ? storyLiveRunView(story, sessions, now) : null,
  );
  const statusLabel = $derived(
    currentPasses ? 'Complete' : liveRun ? 'Active' : 'To do',
  );
  const statusTone = $derived(
    currentPasses ? 'complete' : liveRun ? 'active' : 'todo',
  );

  async function setPasses(next: boolean) {
    if (!story || saving || next === currentPasses) return;
    const previous = currentPasses;
    passesOverride = next;
    saving = true;
    error = null;
    const result = await setStoryPasses(prdPath, story.id, previous, next);
    saving = false;
    if (result.ok) {
      passesOverride = result.passes;
      onStoryPassesChange?.(story.id, result.passes);
    } else {
      passesOverride = previous;
      error = result.error;
    }
  }

  async function openPrd() {
    if (!prdPath || footerBusy) return;
    footerBusy = 'prd';
    footerMessage = null;
    try {
      await invoke('open_in_editor', { path: prdPath });
    } catch (err) {
      console.error('open_in_editor failed:', err);
      footerMessage = 'Could not open the PRD file.';
    } finally {
      footerBusy = null;
    }
  }

  async function copyStoryId() {
    if (!story || footerBusy) return;
    footerBusy = 'copy';
    footerMessage = null;
    try {
      await navigator.clipboard.writeText(story.id);
      footerMessage = 'Story ID copied.';
    } catch {
      footerMessage = 'Could not copy story ID.';
    } finally {
      footerBusy = null;
    }
  }

  async function runStory() {
    if (!story || footerBusy) return;
    footerBusy = 'run';
    footerMessage = null;
    const projectName = project ? projectDisplayName(project) : 'the current project';
    const prompt = [
      `/run-project ${story.id}`,
      '',
      `Run story ${story.id}: ${story.title}`,
      `Project: ${projectName}`,
      prdPath ? `PRD: ${prdPath}` : null,
      story.description ? `Description: ${story.description}` : null,
      acItems.length > 0
        ? ['Acceptance criteria:', ...acItems.map((item) => `- ${item}`)].join('\n')
        : null,
      '',
      'Execute this story through the normal HQ project workflow, update the PRD/story state when done, and run the relevant checks before reporting back.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    try {
      const config: { hqFolderPath?: string } = await invoke<{ hqFolderPath?: string }>(
        'get_config',
      ).catch(() => ({}));
      const url = buildClaudeCodeUrl({ folder: config.hqFolderPath ?? '', prompt });
      await invoke('open_claude_code_link', { url });
      footerMessage = 'Story opened in Claude Code.';
    } catch (err) {
      console.error('open_claude_code_link failed:', err);
      try {
        await navigator.clipboard.writeText(prompt);
        footerMessage = 'Story prompt copied.';
      } catch {
        footerMessage = 'Could not open Claude Code.';
      }
    } finally {
      footerBusy = null;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }

  function fileBasename(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }
</script>

<svelte:window onkeydown={story ? handleKeydown : undefined} />

{#if story}
  <!-- DESKTOP-006: no dimmed modal backdrop — task opens in the project workspace. -->
  <aside
    class="story-panel"
    class:is-embedded={embedded}
    aria-label={`Story ${story.id}`}
    data-testid="v4-story-panel"
    data-embedded={embedded ? 'true' : 'false'}
  >
    <header class="panel-header">
      <div class="header-copy">
        <span class="hierarchy" data-testid="task-detail-hierarchy">{hierarchy}</span>
        <div class="title-stack">
          <span class="story-id" data-testid="task-detail-id">{story.id}</span>
          <h2 data-testid="task-detail-title">{story.title}</h2>
        </div>
        <div class="meta-row">
          <span class="status-pill tone-{statusTone}" data-testid="task-detail-status">
            {#if liveRun && !currentPasses}
              <span class="live-dot" aria-hidden="true"></span>
            {/if}
            {statusLabel}
          </span>
          {#if priority}
            <span class="priority" data-priority={priority}>{priority}</span>
          {/if}
          {#each labels as label (label)}
            <LabelChip {label} />
          {/each}
        </div>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Close story"
        data-testid="task-detail-close"
        onclick={onclose}
      >
        ×
      </button>
    </header>

    <div class="status-control" aria-label="Story status" data-testid="task-status-control">
      <button
        type="button"
        class:active={!currentPasses}
        disabled={saving}
        onclick={() => setPasses(false)}
      >
        To do
      </button>
      <button
        type="button"
        class:active={currentPasses}
        disabled={saving}
        onclick={() => setPasses(true)}
      >
        Done
      </button>
    </div>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="panel-body">
      {#if liveRun}
        <section class="live-monitor" data-testid="task-agent-activity" aria-label="Agent activity">
          <div class="live-run-head">
            <span class="live-run-phase">
              <span class="live-dot" aria-hidden="true"></span>
              {#if liveRun.phase}
                {liveRun.phase}
              {/if}
            </span>
            {#if liveRun.elapsed}
              <span class="live-run-time">{liveRun.elapsed}</span>
            {/if}
          </div>
          {#if liveRun.progressPercent !== null}
            <div class="live-run-track" aria-hidden="true">
              <span style={`width: ${liveRun.progressPercent}%`}></span>
            </div>
          {/if}
          <div class="live-run-foot">
            <span>
              {liveRun.workers}
              {liveRun.workers === 1 ? 'worker' : 'workers'}
              {#if liveRun.subagents !== null}
                · {liveRun.subagents}
                {liveRun.subagents === 1 ? 'subagent' : 'subagents'}
              {:else}
                · subagents unavailable
              {/if}
            </span>
            <span>
              {#if liveRun.lastSignalAt}
                {relativeActivity(liveRun.lastSignalAt, now)}
              {:else}
                signal unavailable
              {/if}
            </span>
          </div>
        </section>
      {:else}
        <section class="section agent-empty" data-testid="task-agent-activity-empty">
          <h3>Agent activity</h3>
          <p>No active run</p>
        </section>
      {/if}

      <section class="section">
        <h3>Hierarchy</h3>
        <p>{project ? projectDisplayName(project) : 'Project'} → {story.id}</p>
      </section>

      {#if story.description}
        <section class="section" data-testid="task-detail-description">
          <h3>Description</h3>
          <p>{story.description}</p>
        </section>
      {/if}

      <section class="section" data-testid="task-detail-acceptance">
        <div class="section-title-row">
          <h3>Acceptance criteria</h3>
          <span data-testid="ac-progress-count">{acComplete}/{acItems.length}</span>
        </div>
        {#if acItems.length > 0}
          <div
            class="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={acItems.length}
            aria-valuenow={acComplete}
            aria-label="Acceptance criteria complete"
          >
            <span style={`width: ${progress}%`}></span>
          </div>
          <ul class="ac-list" data-testid="ac-checklist">
            {#each acItems as item, index (index)}
              <li class:is-done={currentPasses}>
                <span class="ac-mark" aria-hidden="true">
                  {currentPasses ? '✓' : '·'}
                </span>
                <p>{item}</p>
              </li>
            {/each}
          </ul>
          <p class="ac-note" data-testid="ac-readonly-note">
            These criteria complete together when the task-level pass state changes.
            Individual criterion state is not in the current model.
          </p>
        {:else}
          <p class="muted">No acceptance criteria listed.</p>
        {/if}
      </section>

      {#if deps.length > 0}
        <section class="section" data-testid="task-detail-dependencies">
          <h3>Depends on</h3>
          <div class="chip-row">
            {#each deps as dep (dep)}
              <button type="button" class="dep-chip" onclick={() => onselectDependency?.(dep)}>
                {dep}
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if labels.length > 0}
        <section class="section" data-testid="task-detail-labels">
          <h3>Labels</h3>
          <div class="chip-row">
            {#each labels as label (label)}
              <LabelChip {label} />
            {/each}
          </div>
        </section>
      {/if}

      {#if notes}
        <section class="section" data-testid="task-detail-notes">
          <h3>Notes</h3>
          <p>{notes}</p>
        </section>
      {/if}

      {#if files.length > 0}
        <section class="section" data-testid="task-detail-files">
          <h3>Files</h3>
          <ul class="file-list">
            {#each files as file (file)}
              <li class="file-item">
                <span class="file-path" title={file}>{fileBasename(file)}</span>
                <OpenFileInClaudeCode {file} folder={hqFolderPath} variant="compact" />
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>

    <footer class="panel-footer">
      <div class="footer-status" role="status">{footerMessage ?? ''}</div>
      <button
        type="button"
        data-testid="copy-story-id"
        onclick={() => void copyStoryId()}
        disabled={footerBusy !== null}
      >
        Copy ID
      </button>
      <button type="button" onclick={() => void openPrd()} disabled={footerBusy !== null || !prdPath}>
        {footerBusy === 'prd' ? 'Opening…' : 'Open PRD'}
      </button>
      <button type="button" class="primary" onclick={() => void runStory()} disabled={footerBusy !== null}>
        {footerBusy === 'run' ? 'Opening…' : 'Run story'}
      </button>
    </footer>
  </aside>
{/if}

<style>
  /* DESKTOP-006: docked panel only — no story-backdrop / dimmed modal path. */

  .story-panel {
    position: relative;
    z-index: 1;
    display: flex;
    width: 100%;
    height: 100%;
    flex-direction: column;
    border-left: 0;
    /* Naked main canvas — no raised card shell */
    background: transparent;
    color: var(--v4-text-1);
    box-shadow: none;
  }

  /* Fallback when not embedded in a workspace slot (still no backdrop). */
  .story-panel:not(.is-embedded) {
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    z-index: 100;
    width: min(420px, 100vw);
    border-left: 1px solid var(--v4-hairline);
    background: var(--v4-ground);
    box-shadow: var(--v4-shadow-popover);
  }

  .panel-header,
  .panel-footer,
  .meta-row,
  .section-title-row,
  .chip-row,
  .live-run-head,
  .live-run-foot {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .panel-header {
    justify-content: space-between;
    gap: var(--v4-space-3);
    padding: var(--v4-space-4) var(--v4-space-4) var(--v4-space-3);
    border-bottom: 1px solid var(--v4-hairline);
  }

  .header-copy {
    min-width: 0;
  }

  .hierarchy,
  .section h3,
  .section-title-row span {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title-stack {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    margin-top: var(--v4-space-1);
  }

  .story-id {
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  h2 {
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--v4-text-1);
    font-size: var(--type-detail, var(--text-lg));
    font-weight: 600;
    line-height: 1.2;
  }

  .meta-row {
    flex-wrap: wrap;
    gap: 6px;
    margin-top: var(--v4-space-2);
  }

  .status-pill,
  .priority,
  .dep-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-size: var(--type-secondary, var(--text-sm));
  }

  .status-pill.tone-complete {
    color: var(--v4-ok);
  }

  .status-pill.tone-active {
    color: var(--v4-ok);
  }

  .status-pill.tone-todo {
    color: var(--v4-text-2);
  }

  .priority {
    font-variant-numeric: tabular-nums;
  }

  .priority[data-priority='P1'] {
    color: var(--v4-error);
  }
  .priority[data-priority='P2'] {
    color: var(--v4-warn);
  }

  .icon-button {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--type-section, var(--text-base));
    cursor: pointer;
  }

  .icon-button:hover {
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }

  .icon-button:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .status-control {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin: var(--v4-space-3) var(--v4-space-4) 0;
    padding: 3px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-inset);
  }

  .status-control button,
  .panel-footer button {
    height: 28px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    cursor: pointer;
  }

  .status-control button.active {
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }

  .status-control button:focus-visible,
  .panel-footer button:focus-visible,
  .dep-chip:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .error {
    margin: var(--v4-space-2) var(--v4-space-4) 0;
    color: var(--v4-error);
    font-size: var(--type-body, var(--text-base));
  }

  .panel-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0;
    min-height: 0;
    padding: 0 var(--v4-space-4) var(--v4-space-4);
    overflow-y: auto;
  }

  /* Hairline sections — naked canvas, no rounded section cards */
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-width: 0;
    padding: var(--v4-space-4) 0;
    border-top: 1px solid var(--v4-hairline);
  }

  .section:first-child {
    border-top: 0;
  }

  .section h3,
  .section p {
    margin: 0;
  }

  .section p,
  .muted {
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    line-height: 1.45;
  }

  .section-title-row {
    justify-content: space-between;
    gap: 10px;
  }

  .section-title-row h3 {
    margin: 0;
  }

  /* Live monitor may be rounded as a distinct payload */
  .live-monitor {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    margin-top: var(--v4-space-3);
    padding: var(--v4-space-3);
    border: 1px solid color-mix(in srgb, var(--v4-ok) 28%, var(--v4-hairline));
    border-radius: 6px;
    background: color-mix(in srgb, var(--v4-ok) 8%, var(--v4-raised));
  }

  .live-run-head,
  .live-run-foot {
    justify-content: space-between;
    gap: var(--v4-space-2);
  }

  .live-run-phase {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--v4-text-1);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 600;
  }

  .live-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }

  .live-run-time,
  .live-run-foot {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-variant-numeric: tabular-nums;
  }

  .live-run-track {
    height: 4px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .live-run-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
  }

  .progress-track {
    height: 4px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-rowline);
  }

  .progress-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
  }

  .ac-list,
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ac-list li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }

  /* Read-only mark — not a checkbox control */
  .ac-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1px solid var(--v4-hairline);
    border-radius: 50%;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1;
  }

  .ac-list li.is-done .ac-mark {
    border-color: color-mix(in srgb, var(--v4-ok) 45%, transparent);
    background: color-mix(in srgb, var(--v4-ok) 12%, transparent);
    color: var(--v4-ok);
  }

  .ac-list li.is-done p {
    color: var(--v4-text-3);
  }

  .ac-note {
    color: var(--v4-text-3) !important;
    font-size: var(--type-metadata, var(--text-micro)) !important;
    line-height: 1.4 !important;
  }

  .chip-row {
    flex-wrap: wrap;
    gap: 6px;
  }

  .dep-chip {
    cursor: pointer;
    font: inherit;
  }

  .dep-chip:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    min-width: 0;
    padding: 2px 4px;
    border-radius: var(--v4-radius-button);
  }

  .file-item:hover {
    background: var(--v4-active-row);
  }

  .file-path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--type-secondary, var(--text-sm));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-item :global(.open-claude-btn.compact) {
    opacity: 0;
    transition: opacity 140ms ease;
  }

  .file-item:hover :global(.open-claude-btn.compact),
  .file-item :global(.open-claude-btn.compact:focus-visible) {
    opacity: 1;
  }

  .panel-footer {
    justify-content: flex-end;
    gap: 8px;
    padding: var(--v4-space-3) var(--v4-space-4);
    border-top: 1px solid var(--v4-hairline);
  }

  .footer-status {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .panel-footer button {
    padding: 0 11px;
    border: 1px solid var(--v4-hairline);
    color: var(--v4-text-2);
  }

  .panel-footer button.primary {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .panel-footer button:disabled {
    opacity: 0.52;
    cursor: progress;
  }

  @media (prefers-reduced-motion: reduce) {
    .file-item :global(.open-claude-btn.compact) {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .live-monitor {
      background: var(--v4-raised);
    }
  }

  @media (max-width: 520px) {
    .story-panel:not(.is-embedded) {
      width: 100vw;
      border-left: 0;
    }

    .panel-header {
      align-items: flex-start;
      padding: var(--v4-space-3);
    }

    .status-control {
      margin-inline: var(--v4-space-3);
    }

    .panel-body {
      padding-inline: var(--v4-space-3);
    }

    .panel-footer {
      flex-wrap: wrap;
      justify-content: flex-start;
      padding: var(--v4-space-3);
    }

    .footer-status {
      flex-basis: 100%;
      white-space: normal;
    }
  }
</style>
