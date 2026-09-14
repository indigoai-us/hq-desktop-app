<script lang="ts">
  /**
   * The `+` menu: what a message can carry besides words.
   *
   *   Image…       the existing file picker (the composer owns the <input>)
   *   Meeting…     the company's recent transcripts, searchable
   *   Signal…      decisions / action items / risks…, grouped by kind
   *   Vault file…  browse the company folder with breadcrumbs and a search
   *   Paste path   any path inside HQ
   *
   * Every pick reports ONE `ContextAttachment` up to the composer, which owns
   * the chips, the cap and the text read. The menu owns only its own
   * navigation and the lists it loads through the loaders it was given —
   * never a raw invoke — so it mounts and drills in a test with a stub set.
   */
  import {
    attachmentFromMeeting,
    attachmentFromPath,
    attachmentFromSignal,
    attachmentFromVault,
    shortDate,
    signalKindLabel,
    type ContextAttachment,
    type ContextLoaders,
    type MeetingEntry,
    type SignalEntry,
    type VaultEntry,
  } from './context-attachments';

  type View = 'root' | 'meetings' | 'signals' | 'vault' | 'path';

  interface Props {
    company: string | null;
    loaders: ContextLoaders | null;
    onimage?: () => void;
    onattach?: (attachment: ContextAttachment) => void;
    onclose?: () => void;
  }

  let { company, loaders, onimage, onattach, onclose }: Props = $props();

  let view = $state<View>('root');
  let query = $state('');
  let loading = $state(false);
  let error = $state('');
  let meetings = $state<MeetingEntry[]>([]);
  let signals = $state<SignalEntry[]>([]);
  let entries = $state<VaultEntry[]>([]);
  /** The vault browser's path segments under the company root. */
  let crumbs = $state<string[]>([]);
  let pathDraft = $state('');
  let searchEl = $state<HTMLInputElement | null>(null);
  /** Guards a stale load landing after a newer one. */
  let loadSeq = 0;

  const ready = $derived(Boolean(company && loaders));
  const lower = (value: string) => value.toLocaleLowerCase('en-US');

  const visibleMeetings = $derived.by(() => {
    const needle = lower(query.trim());
    if (!needle) return meetings;
    return meetings.filter(
      (meeting) =>
        lower(meeting.title).includes(needle) ||
        meeting.participants.some((person) => lower(person).includes(needle)) ||
        lower(meeting.summary).includes(needle),
    );
  });

  const signalGroups = $derived.by(() => {
    const needle = lower(query.trim());
    const groups = new Map<string, SignalEntry[]>();
    for (const signal of signals) {
      if (needle && !lower(signal.title).includes(needle) && !lower(signal.snippet).includes(needle)) {
        continue;
      }
      const list = groups.get(signal.kind) ?? [];
      list.push(signal);
      groups.set(signal.kind, list);
    }
    return [...groups.entries()].map(([kind, list]) => ({
      kind,
      label: signalKindLabel(kind),
      signals: list,
    }));
  });

  async function load<T>(work: () => Promise<T>, apply: (value: T) => void) {
    const seq = (loadSeq += 1);
    loading = true;
    error = '';
    try {
      const value = await work();
      if (seq !== loadSeq) return;
      apply(value);
    } catch (err) {
      if (seq !== loadSeq) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function openMeetings() {
    if (!company || !loaders) return;
    view = 'meetings';
    query = '';
    meetings = [];
    const slug = company;
    void load(() => loaders.meetings(slug), (rows) => (meetings = rows));
    focusSearch();
  }

  function openSignals() {
    if (!company || !loaders) return;
    view = 'signals';
    query = '';
    signals = [];
    const slug = company;
    void load(() => loaders.signals(slug), (rows) => (signals = rows));
    focusSearch();
  }

  function openVault(segments: string[] = []) {
    if (!company || !loaders) return;
    view = 'vault';
    query = '';
    crumbs = segments;
    listVault();
    focusSearch();
  }

  function listVault() {
    if (!company || !loaders) return;
    const slug = company;
    const prefix = crumbs.join('/');
    const needle = query.trim();
    entries = [];
    void load(() => loaders.vaultFiles(slug, prefix, needle), (rows) => (entries = rows));
  }

  function openPath() {
    view = 'path';
    pathDraft = '';
  }

  function back() {
    view = 'root';
    query = '';
    error = '';
  }

  function focusSearch() {
    queueMicrotask(() => searchEl?.focus());
  }

  function onSearchInput(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    if (view === 'vault') listVault();
  }

  function pickMeeting(meeting: MeetingEntry) {
    onattach?.(attachmentFromMeeting(meeting));
  }

  function pickSignal(signal: SignalEntry) {
    onattach?.(attachmentFromSignal(signal));
  }

  function pickVault(entry: VaultEntry) {
    if (entry.kind === 'dir') {
      openVault([...crumbs, entry.name]);
      return;
    }
    onattach?.(attachmentFromVault(entry));
  }

  function submitPath() {
    const trimmed = pathDraft.trim();
    if (!trimmed) return;
    onattach?.(attachmentFromPath(trimmed));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (view === 'root') onclose?.();
      else back();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="attach-menu"
  role="menu"
  tabindex="-1"
  data-testid="session-attach-menu"
  data-view={view}
  onclick={(event) => event.stopPropagation()}
  onkeydown={onKeydown}
>
  {#if view === 'root'}
    <button type="button" role="menuitem" class="item" data-testid="session-attach-image" onclick={() => onimage?.()}>
      <span class="item-label">Image…</span>
      <span class="item-sub">PNG, JPEG, up to 4 MB</span>
    </button>
    <button
      type="button"
      role="menuitem"
      class="item"
      disabled={!ready}
      data-testid="session-attach-meeting"
      onclick={openMeetings}
    >
      <span class="item-label">Meeting…</span>
      <span class="item-sub">A recent transcript</span>
    </button>
    <button
      type="button"
      role="menuitem"
      class="item"
      disabled={!ready}
      data-testid="session-attach-signal"
      onclick={openSignals}
    >
      <span class="item-label">Signal…</span>
      <span class="item-sub">A decision, action item, risk…</span>
    </button>
    <button
      type="button"
      role="menuitem"
      class="item"
      disabled={!ready}
      data-testid="session-attach-vault"
      onclick={() => openVault()}
    >
      <span class="item-label">Vault file…</span>
      <span class="item-sub">Browse the company folder</span>
    </button>
    <button
      type="button"
      role="menuitem"
      class="item"
      disabled={!loaders}
      data-testid="session-attach-path"
      onclick={openPath}
    >
      <span class="item-label">Paste path</span>
      <span class="item-sub">Any file inside HQ</span>
    </button>
    {#if !ready}
      <p class="note" data-testid="session-attach-no-company">Pick a company to attach its context.</p>
    {/if}
  {:else}
    <div class="head">
      <button type="button" class="back" aria-label="Back" data-testid="session-attach-back" onclick={back}>
        ←
      </button>
      <span class="title">
        {#if view === 'meetings'}Meetings{:else if view === 'signals'}Signals{:else if view === 'vault'}Vault files{:else}Paste a path{/if}
      </span>
    </div>

    {#if view === 'path'}
      <div class="path-row">
        <input
          class="search"
          type="text"
          placeholder="companies/indigo/knowledge/brief.md"
          aria-label="Path inside HQ"
          data-testid="session-attach-path-input"
          bind:value={pathDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitPath();
            }
          }}
        />
        <button
          type="button"
          class="go"
          disabled={!pathDraft.trim()}
          data-testid="session-attach-path-submit"
          onclick={submitPath}
        >
          Attach
        </button>
      </div>
    {:else}
      <input
        bind:this={searchEl}
        class="search"
        type="text"
        value={query}
        placeholder={view === 'vault' ? 'Filter this folder…' : 'Search…'}
        aria-label="Search"
        data-testid="session-attach-search"
        oninput={onSearchInput}
      />
    {/if}

    {#if view === 'vault'}
      <div class="crumbs" data-testid="session-attach-crumbs">
        <button type="button" class="crumb" data-testid="session-attach-crumb" onclick={() => openVault([])}>
          {company}
        </button>
        {#each crumbs as segment, depth (depth)}
          <span class="crumb-sep" aria-hidden="true">/</span>
          <button
            type="button"
            class="crumb"
            data-testid="session-attach-crumb"
            onclick={() => openVault(crumbs.slice(0, depth + 1))}
          >
            {segment}
          </button>
        {/each}
      </div>
    {/if}

    <div class="list">
      {#if loading}
        <p class="note" data-testid="session-attach-loading">Loading…</p>
      {:else if error}
        <p class="note error" role="alert" data-testid="session-attach-error">{error}</p>
      {:else if view === 'meetings'}
        {#if visibleMeetings.length === 0}
          <p class="note" data-testid="session-attach-empty">No meetings found.</p>
        {/if}
        {#each visibleMeetings as meeting (meeting.path)}
          <button
            type="button"
            role="menuitem"
            class="item"
            data-testid="session-attach-meeting-row"
            title={meeting.summary}
            onclick={() => pickMeeting(meeting)}
          >
            <span class="item-label">
              <span class="grow">{meeting.title || meeting.id}</span>
              {#if meeting.date}<span class="when">{shortDate(meeting.date)}</span>{/if}
            </span>
            {#if meeting.participants.length > 0}
              <span class="item-sub">{meeting.participants.join(', ')}</span>
            {/if}
          </button>
        {/each}
      {:else if view === 'signals'}
        {#if signalGroups.length === 0}
          <p class="note" data-testid="session-attach-empty">No signals found.</p>
        {/if}
        {#each signalGroups as group (group.kind)}
          <div class="group-label" data-testid="session-attach-signal-kind">{group.label}</div>
          {#each group.signals as signal (signal.path)}
            <button
              type="button"
              role="menuitem"
              class="item"
              data-testid="session-attach-signal-row"
              title={signal.snippet}
              onclick={() => pickSignal(signal)}
            >
              <span class="item-label">
                <span class="grow">{signal.title}</span>
                {#if signal.date}<span class="when">{shortDate(signal.date)}</span>{/if}
              </span>
              {#if signal.snippet}<span class="item-sub">{signal.snippet}</span>{/if}
            </button>
          {/each}
        {/each}
      {:else if view === 'vault'}
        {#if entries.length === 0}
          <p class="note" data-testid="session-attach-empty">Empty folder.</p>
        {/if}
        {#each entries as entry (entry.path)}
          <button
            type="button"
            role="menuitem"
            class="item"
            data-testid="session-attach-vault-row"
            data-kind={entry.kind}
            onclick={() => pickVault(entry)}
          >
            <span class="item-label">
              <span class="glyph" aria-hidden="true">{entry.kind === 'dir' ? '▸' : '·'}</span>
              <span class="grow">{entry.name}</span>
              {#if entry.kind === 'file'}<span class="when">{entry.bytes} B</span>{/if}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .attach-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 320px;
    max-height: 340px;
    padding: 4px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
    font-family: var(--font-sans);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 4px;
  }

  .back {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    cursor: pointer;
  }

  .back:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .title {
    font-size: var(--type-metadata);
    font-weight: 600;
    color: var(--v4-text-1);
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    height: 26px;
    margin-bottom: 4px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    outline: none;
  }

  .path-row {
    display: flex;
    gap: 4px;
  }

  .path-row .search {
    flex: 1;
    min-width: 0;
    margin-bottom: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
  }

  .go {
    flex: none;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .go:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    padding: 0 4px 4px;
    font-size: 11px;
  }

  .crumb {
    padding: 1px 4px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    cursor: pointer;
  }

  .crumb:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .crumb-sep {
    color: var(--v4-text-3);
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .group-label {
    padding: 4px 8px 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .item {
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

  .item:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .item:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .item-label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    font-weight: 600;
  }

  .grow {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .glyph {
    flex: none;
    color: var(--v4-text-3);
  }

  .when {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 400;
    color: var(--v4-text-3);
  }

  .item-sub {
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
