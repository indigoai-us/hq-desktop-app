<script lang="ts">
  /**
   * The company pill's second level: a company's projects, with "No project"
   * first — searchable, most recently worked on first, narrowable by person
   * and by status.
   *
   * Every row is one project: owner initials, the name, "updated 2h ago", a
   * slim story bar with its `done/total`, and the description on one line
   * (the full text rides a tooltip only when the line is actually clipped —
   * a tooltip that repeats what is already legible is noise).
   *
   * The filters are chips: **Active · All** for status (done and archived
   * projects hide by default), and one chip per distinct owner — **Mine**
   * first when the signed-in viewer owns any. The search matches name and
   * description; a name-prefix hit outranks the rest.
   *
   * Presentation only — every decision is a pure function in `startwork.ts`,
   * the composer loads the list (through the store) and remembers the pick
   * per company.
   */
  import { tick } from 'svelte';
  import {
    filterProjects,
    ownerChips,
    ownerInitials,
    ownerLabel,
    relativeTime,
    sameOwner,
    storyPercent,
    storyProgress,
    type ProjectEntry,
    type ProjectStatusFilter,
    type ProjectViewer,
  } from './startwork';

  interface Props {
    projects: ProjectEntry[];
    /** The chosen project's name, or null for "No project". */
    selected: string | null;
    loading?: boolean;
    error?: string;
    /** Who is looking — puts "Mine" first among the person chips. */
    viewer?: ProjectViewer | null;
    /** Take the caret into the search box on open. */
    autofocus?: boolean;
    onpick?: (name: string | null) => void;
  }

  let {
    projects,
    selected,
    loading = false,
    error = '',
    viewer = null,
    autofocus = true,
    onpick,
  }: Props = $props();

  let query = $state('');
  let owner = $state<string | null>(null);
  let status = $state<ProjectStatusFilter>('active');
  let highlighted = $state(0);
  let search = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  const now = Date.now();

  /** Person chips come from the rows the status filter leaves, so none is dead. */
  const inStatus = $derived(
    status === 'active'
      ? projects.filter((entry) => !entry.status || entry.status === 'active')
      : projects,
  );
  const chips = $derived(ownerChips(inStatus, viewer));
  const rows = $derived(filterProjects(projects, { query, owner, status }));
  /** How many the Active filter is hiding for this query and person. */
  const hiddenByStatus = $derived(
    status === 'active'
      ? filterProjects(projects, { query, owner, status: 'all' }).length - rows.length
      : 0,
  );

  /** "No project" is always item 0; the rows follow. */
  const count = $derived(rows.length + 1);
  const index = $derived(Math.min(Math.max(highlighted, 0), count - 1));

  // A new query or chip resets the highlight to the best match.
  let lastKey = $state('');
  $effect(() => {
    const key = `${query} ${owner ?? ''} ${status}`;
    if (key === lastKey) return;
    lastKey = key;
    highlighted = 0;
  });

  $effect(() => {
    void index;
    void tick().then(() => {
      const el = list?.querySelector<HTMLElement>('[data-highlighted="true"]');
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    });
  });

  $effect(() => {
    if (!autofocus) return;
    const el = search;
    if (!el) return;
    void tick().then(() => {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    });
  });

  function pickAt(at: number) {
    if (at === 0) {
      onpick?.(null);
      return;
    }
    const row = rows[at - 1];
    if (row) onpick?.(row.name);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlighted = (index + 1) % count;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlighted = (index - 1 + count) % count;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      pickAt(index);
    }
  }

  function toggleOwner(next: string) {
    owner = sameOwner(owner, next) ? null : next;
  }

  /**
   * The full description rides a tooltip ONLY when the one-line clip cut it.
   * Re-checked on every update so a widened menu drops the tooltip again.
   */
  function clipTitle(node: HTMLElement, text: string) {
    const apply = (value: string) => {
      if (node.scrollWidth > node.clientWidth) node.title = value;
      else node.removeAttribute('title');
    };
    apply(text);
    return {
      update(value: string) {
        apply(value);
      },
    };
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="project-picker" data-testid="session-project-picker" onkeydown={onKeydown}>
  <div class="head">
    <div class="search-wrap">
      <svg class="search-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="5" cy="5" r="3.6" stroke="currentColor" stroke-width="1.3" />
        <path d="M7.8 7.8 10.6 10.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <input
        bind:this={search}
        bind:value={query}
        class="search"
        type="text"
        placeholder="Search projects…"
        aria-label="Search projects"
        autocomplete="off"
        spellcheck="false"
        data-testid="session-project-search"
      />
    </div>
    <div class="filters">
      <div class="segment" role="group" aria-label="Status">
        <button
          type="button"
          class="seg"
          class:active={status === 'active'}
          aria-pressed={status === 'active'}
          data-testid="session-project-status-active"
          onclick={() => (status = 'active')}
        >
          Active
        </button>
        <button
          type="button"
          class="seg"
          class:active={status === 'all'}
          aria-pressed={status === 'all'}
          data-testid="session-project-status-all"
          onclick={() => (status = 'all')}
        >
          All
        </button>
      </div>
      {#if chips.length > 0}
        <div class="people" role="group" aria-label="Person" data-testid="session-project-people">
          {#each chips as chip (chip.owner)}
            <button
              type="button"
              class="chip"
              class:active={sameOwner(owner, chip.owner)}
              class:mine={chip.mine}
              aria-pressed={sameOwner(owner, chip.owner)}
              title={chip.mine ? `${chip.owner} (you)` : chip.owner}
              data-testid="session-project-person"
              data-owner={chip.owner}
              data-mine={chip.mine}
              onclick={() => toggleOwner(chip.owner)}
            >
              <span class="chip-avatar" aria-hidden="true">{ownerInitials(chip.owner)}</span>
              <span class="chip-label">{chip.label}</span>
              <span class="chip-count">{chip.count}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="list" role="listbox" aria-label="Projects" bind:this={list}>
    <button
      type="button"
      role="option"
      aria-selected={selected === null}
      class="row none"
      class:highlighted={index === 0}
      class:current={selected === null}
      data-highlighted={index === 0}
      data-testid="session-project-none"
      onmouseenter={() => (highlighted = 0)}
      onclick={() => onpick?.(null)}
    >
      <span class="avatar none-avatar" aria-hidden="true">—</span>
      <span class="body">
        <span class="line">
          <span class="name">No project</span>
          <span class="updated">Orient on the company</span>
        </span>
      </span>
      {#if selected === null}
        <span class="check" aria-hidden="true">✓</span>
      {/if}
    </button>

    {#if loading && projects.length === 0}
      <p class="note" data-testid="session-project-loading">Loading projects…</p>
    {:else if error}
      <p class="note error" data-testid="session-project-error">{error}</p>
    {:else if projects.length === 0}
      <p class="note" data-testid="session-project-empty">No projects in this company yet.</p>
    {:else if rows.length === 0}
      <p class="note" data-testid="session-project-no-match">
        No projects match{query.trim() ? ` "${query.trim()}"` : ''}.
      </p>
    {/if}

    {#each rows as project, i (project.path)}
      {@const at = i + 1}
      <button
        type="button"
        role="option"
        aria-selected={selected === project.name}
        class="row"
        class:highlighted={index === at}
        class:current={selected === project.name}
        data-highlighted={index === at}
        data-testid="session-project-item"
        data-name={project.name}
        data-owner={project.owner ?? ''}
        data-status={project.status}
        onmouseenter={() => (highlighted = at)}
        onclick={() => onpick?.(project.name)}
      >
        <span
          class="avatar"
          class:unowned={!project.owner}
          title={project.owner ? ownerLabel(project.owner) : 'No owner'}
          data-testid="session-project-avatar"
        >
          {ownerInitials(project.owner)}
        </span>
        <span class="body">
          <span class="line">
            <span class="name">{project.name}</span>
            {#if project.status !== 'active'}
              <span class="status-tag" data-testid="session-project-status">{project.status}</span>
            {/if}
            {#if relativeTime(project.lastActivityAt ?? project.updatedAt, now)}
              <span class="updated" data-testid="session-project-updated">
                updated {relativeTime(project.lastActivityAt ?? project.updatedAt, now)}
              </span>
            {/if}
          </span>
          {#if project.description}
            <span class="description" use:clipTitle={project.description}>{project.description}</span>
          {/if}
          <span class="progress">
            <span class="track" aria-hidden="true">
              <span
                class="fill"
                data-testid="session-project-progress"
                style:width={`${storyPercent(project)}%`}
              ></span>
            </span>
            <span class="count" data-testid="session-project-count">{storyProgress(project)}</span>
          </span>
        </span>
        {#if selected === project.name}
          <span class="check" aria-hidden="true">✓</span>
        {/if}
      </button>
    {/each}

    {#if hiddenByStatus > 0}
      <button
        type="button"
        class="show-all"
        data-testid="session-project-show-all"
        onclick={() => (status = 'all')}
      >
        {hiddenByStatus} done or archived hidden · Show all
      </button>
    {/if}
  </div>
</div>

<style>
  .project-picker {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    font-family: var(--font-sans);
  }

  /* --- head: search + filters ------------------------------------------ */

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    padding: 4px 4px var(--v4-space-2);
    border-bottom: 1px solid var(--v4-hairline);
  }

  .search-wrap {
    position: relative;
  }

  .search-icon {
    position: absolute;
    left: 9px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--v4-text-3);
    pointer-events: none;
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    height: 30px;
    padding: 0 10px 0 26px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-field);
    background: var(--v4-control-faint, var(--v4-inset));
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    outline: none;
  }

  .search::placeholder {
    color: var(--v4-text-3);
  }

  .search:focus {
    border-color: var(--v4-control-border, var(--v4-hairline));
    background: transparent;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .segment {
    display: inline-flex;
    flex: none;
    padding: 2px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint, var(--v4-inset));
  }

  .seg {
    height: 20px;
    padding: 0 9px;
    border: 0;
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .seg.active {
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font-weight: 600;
    box-shadow: var(--v4-shadow-card, none);
  }

  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px 0 3px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
  }

  .chip:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .chip.mine .chip-label {
    font-weight: 600;
  }

  .chip.active {
    background: var(--v4-primary-bg);
    border-color: transparent;
    color: var(--v4-primary-fg);
  }

  .chip-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--v4-control-bg);
    color: var(--v4-text-2);
    font-size: 9px;
    font-weight: 600;
  }

  .chip.active .chip-avatar {
    background: color-mix(in srgb, var(--v4-primary-fg) 22%, transparent);
    color: var(--v4-primary-fg);
  }

  .chip-count {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    opacity: 0.7;
  }

  /* --- rows --------------------------------------------------------------- */

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0 0;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--v4-space-2);
    width: 100%;
    padding: 6px var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--v4-active-row);
  }

  .row.highlighted {
    background: var(--v4-control-bg);
    box-shadow: inset 0 0 0 1px var(--v4-control-border, var(--v4-hairline));
  }

  .row.none {
    align-items: center;
  }

  .avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 22px;
    height: 22px;
    margin-top: 1px;
    border-radius: 50%;
    background: var(--v4-control-bg);
    color: var(--v4-text-2);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .avatar.unowned,
  .none-avatar {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
    color: var(--v4-text-3);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .name {
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-tag {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: 10px;
    line-height: 1.3;
  }

  .updated {
    flex: none;
    margin-left: auto;
    font-size: 11px;
    color: var(--v4-text-3);
    white-space: nowrap;
  }

  .description {
    color: var(--v4-text-3);
    font-size: 11px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .track {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--v4-control-faint, var(--v4-inset));
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--v4-text-2);
  }

  .row.current .fill {
    background: var(--v4-text-1);
  }

  .count {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    color: var(--v4-text-3);
  }

  .check {
    flex: none;
    align-self: center;
    font-size: 11px;
    color: var(--v4-text-2);
  }

  .show-all {
    width: 100%;
    padding: 6px var(--v4-space-2);
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .show-all:hover {
    color: var(--v4-text-1);
  }

  .note {
    margin: 0;
    padding: 6px var(--v4-space-2);
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .note.error {
    color: var(--v4-error, var(--v4-text-2));
  }
</style>
