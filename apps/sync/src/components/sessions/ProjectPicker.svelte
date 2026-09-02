<script lang="ts">
  /**
   * The company pill's second level: a company's projects, with "No project"
   * first. Each row is the project's name and its `done/total` story count.
   * Presentation only — the composer loads the list (through the store) and
   * remembers the pick per company.
   */
  import { storyProgress, type ProjectEntry } from './startwork';

  interface Props {
    projects: ProjectEntry[];
    /** The chosen project's name, or null for "No project". */
    selected: string | null;
    loading?: boolean;
    error?: string;
    onpick?: (name: string | null) => void;
  }

  let { projects, selected, loading = false, error = '', onpick }: Props = $props();
</script>

<div class="project-picker" data-testid="session-project-picker">
  <button
    type="button"
    role="menuitemradio"
    aria-checked={selected === null}
    class="menu-item"
    class:selected={selected === null}
    data-testid="session-project-none"
    onclick={() => onpick?.(null)}
  >
    <span class="menu-label">No project</span>
    <span class="menu-sub">Orient on the company</span>
  </button>
  {#if loading && projects.length === 0}
    <p class="note" data-testid="session-project-loading">Loading projects…</p>
  {:else if error}
    <p class="note error" data-testid="session-project-error">{error}</p>
  {:else if projects.length === 0}
    <p class="note" data-testid="session-project-empty">No projects in this company yet.</p>
  {/if}
  {#each projects as project (project.path)}
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected === project.name}
      class="menu-item"
      class:selected={selected === project.name}
      data-testid="session-project-item"
      data-name={project.name}
      title={project.description}
      onclick={() => onpick?.(project.name)}
    >
      <span class="menu-label">
        <span class="name">{project.name}</span>
        <span class="count" data-testid="session-project-count">{storyProgress(project)}</span>
      </span>
      {#if project.description}
        <span class="menu-sub">{project.description}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .project-picker {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .menu-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .menu-item:hover {
    background: var(--v4-active-row);
  }

  .menu-label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-weight: 600;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    flex: none;
    margin-left: auto;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 400;
    color: var(--v4-text-3);
  }

  .menu-sub {
    color: var(--v4-text-3);
    font-size: 11px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    margin: 0;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .note.error {
    color: var(--v4-error, var(--v4-text-2));
  }
</style>
