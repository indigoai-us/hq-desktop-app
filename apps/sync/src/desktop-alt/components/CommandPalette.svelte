<script lang="ts">
  import { onMount, tick } from 'svelte';

  export interface CommandPaletteItem {
    id: string;
    label: string;
    detail: string;
    shortcut?: string;
    action: () => void | Promise<void>;
    /**
     * When set (conversation rows, US-013), the palette ranks by match then
     * recency instead of the generic command fuzzy filter alone.
     */
    lastActivityAt?: number;
  }

  interface Props {
    commands: CommandPaletteItem[];
    onclose: () => void;
  }

  interface CommandPaletteSection {
    id: 'actions' | 'navigate' | 'conversations';
    label: 'ACTIONS' | 'NAVIGATE' | 'CONVERSATIONS';
    items: CommandPaletteItem[];
  }
  interface CommandActionError {
    command: CommandPaletteItem;
    message: string;
  }

  let { commands, onclose }: Props = $props();
  let query = $state('');
  let highlightedIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let paletteEl: HTMLDivElement | null = $state(null);
  let executingId = $state<string | null>(null);
  let actionError = $state<CommandActionError | null>(null);

  function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return 'The command was rejected before it could finish.';
  }

  function fuzzyMatch(value: string, needle: string): boolean {
    const haystack = value.toLowerCase();
    const queryText = needle.trim().toLowerCase();
    if (!queryText) return true;

    let searchFrom = 0;
    for (const char of queryText) {
      const foundAt = haystack.indexOf(char, searchFrom);
      if (foundAt === -1) return false;
      searchFrom = foundAt + 1;
    }
    return true;
  }

  function isConversationItem(command: CommandPaletteItem): boolean {
    return command.id.startsWith('conversation-');
  }

  /** Match score for conversation rows: starts-with > contains > none. */
  function conversationMatchScore(command: CommandPaletteItem, needle: string): number {
    const q = needle.trim().toLowerCase();
    if (!q) return 1;
    const title = command.label.toLowerCase();
    if (title.startsWith(q)) return 3;
    if (title.includes(q)) return 2;
    if (command.detail.toLowerCase().includes(q)) return 1;
    return 0;
  }

  const filteredCommands = $derived.by((): CommandPaletteItem[] => {
    const actionNav = commands.filter((command) => !isConversationItem(command));
    const conversationItems = commands.filter(isConversationItem);

    const filteredActionNav = actionNav.filter((command) =>
      fuzzyMatch(`${command.label} ${command.detail} ${command.shortcut ?? ''}`, query),
    );

    const rankedConversations = conversationItems
      .map((command) => ({ command, score: conversationMatchScore(command, query) }))
      .filter((entry) => (query.trim() ? entry.score > 0 : true))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aAt = a.command.lastActivityAt ?? 0;
        const bAt = b.command.lastActivityAt ?? 0;
        if (bAt !== aAt) return bAt - aAt;
        return a.command.label.localeCompare(b.command.label);
      })
      .slice(0, 12)
      .map((entry) => entry.command);

    // Commands first, then ranked conversations under them (US-013).
    return [...filteredActionNav, ...rankedConversations];
  });

  function sectionId(command: CommandPaletteItem): CommandPaletteSection['id'] {
    // Conversations (US-013) sit under their own section after actions/navigate.
    if (command.id.startsWith('conversation-')) return 'conversations';
    return command.id.startsWith('command-go-') ? 'navigate' : 'actions';
  }

  const commandSections = $derived.by((): CommandPaletteSection[] => {
    const sections: CommandPaletteSection[] = [
      { id: 'actions', label: 'ACTIONS', items: [] },
      { id: 'navigate', label: 'NAVIGATE', items: [] },
      { id: 'conversations', label: 'CONVERSATIONS', items: [] },
    ];
    for (const command of filteredCommands) {
      const target = sections.find((section) => section.id === sectionId(command));
      target?.items.push(command);
    }
    return sections.filter((section) => section.items.length > 0);
  });

  $effect(() => {
    if (highlightedIndex >= filteredCommands.length) {
      highlightedIndex = Math.max(0, filteredCommands.length - 1);
    }
  });

  $effect(() => {
    query;
    highlightedIndex = 0;
  });

  onMount(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => inputEl?.focus());

    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  });

  async function execute(command: CommandPaletteItem | undefined) {
    if (!command || executingId) return;
    executingId = command.id;
    if (actionError?.command.id !== command.id) actionError = null;
    // Give the selected row an immediate pending state before a native invoke
    // or navigation can block/replace this surface.
    await tick();
    try {
      await command.action();
      onclose();
    } catch (err) {
      console.error('command-palette: action failed', err);
      actionError = { command, message: errorMessage(err) };
    } finally {
      executingId = null;
    }
  }

  async function revealHighlightedOption() {
    await tick();
    paletteEl
      ?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      const focusable = [
        inputEl,
        ...(paletteEl?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
      ].filter(
        (element): element is HTMLInputElement | HTMLButtonElement =>
          element instanceof HTMLElement,
      );
      const first = focusable[0];
      const last = focusable.at(-1);

      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
      return;
    }

    if (event.key === 'Escape' && !executingId) {
      event.preventDefault();
      onclose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightedIndex =
        filteredCommands.length === 0 ? 0 : (highlightedIndex + 1) % filteredCommands.length;
      void revealHighlightedOption();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightedIndex =
        filteredCommands.length === 0
          ? 0
          : (highlightedIndex - 1 + filteredCommands.length) % filteredCommands.length;
      void revealHighlightedOption();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      void execute(filteredCommands[highlightedIndex]);
    }
  }
</script>

<div
  class="command-backdrop"
  role="presentation"
  onclick={() => {
    if (!executingId) onclose();
  }}
>
  <div
    bind:this={paletteEl}
    class="command-palette"
    role="dialog"
    aria-modal="true"
    aria-labelledby="command-palette-title"
    aria-busy={!!executingId}
    tabindex="-1"
    onkeydown={handleKeydown}
    onclick={(event) => event.stopPropagation()}
  >
    <div class="command-input-row">
      <span class="command-glyph" aria-hidden="true">⌘K</span>
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="Filter commands"
        aria-controls="command-palette-list"
        aria-activedescendant={filteredCommands[highlightedIndex]?.id}
        placeholder="Search commands"
      />
    </div>

    <h2 id="command-palette-title">Command palette</h2>

    {#if actionError}
      {@const failure = actionError}
      <div class="command-action-error" role="alert" title={failure.message}>
        <span>Couldn’t run <strong>{failure.command.label}</strong>.</span>
        <button
          type="button"
          onclick={() => void execute(failure.command)}
          disabled={!!executingId}
          aria-busy={executingId === failure.command.id}
        >
          {executingId === failure.command.id ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    {/if}

    <div id="command-palette-list" class="command-list" role="listbox" aria-label="Commands">
      {#if commandSections.length > 0}
        {#each commandSections as section (section.id)}
          <div class="command-section" role="presentation">
            <div class="command-section-title">{section.label}</div>
            {#each section.items as command (command.id)}
              {@const index = filteredCommands.indexOf(command)}
              <button
                id={command.id}
                class:highlighted={index === highlightedIndex}
                type="button"
                role="option"
                aria-selected={index === highlightedIndex}
                aria-busy={executingId === command.id}
                disabled={!!executingId}
                onfocus={() => {
                  highlightedIndex = index;
                }}
                onmouseenter={() => {
                  highlightedIndex = index;
                }}
                onclick={() => void execute(command)}
              >
                <span class="command-copy">
                  <strong>{command.label}</strong>
                  <span>{executingId === command.id ? 'Opening…' : command.detail}</span>
                </span>
                {#if executingId === command.id}
                  <span class="command-spinner" aria-hidden="true"></span>
                {:else if command.shortcut}
                  <kbd>{command.shortcut}</kbd>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      {:else}
        <div class="command-empty" role="status">No commands found</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .command-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: clamp(48px, 9vh, 72px) 20px 20px;
    background: rgba(0, 0, 0, 0.14);
  }

  .command-palette {
    display: flex;
    flex-direction: column;
    width: min(560px, 100%);
    max-height: min(640px, calc(100dvh - 96px));
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--pop-border);
    border-radius: var(--v4-radius-popover);
    background: var(--v4-popover, var(--pop-bg));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, var(--pop-shadow)), inset 0 1px 0 var(--v4-glass-highlight);
    color: var(--pop-text);
    transform-origin: top center;
  }

  .command-palette h2 {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .command-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    flex: 0 0 auto;
    padding: 0 12px;
    border-bottom: 1px solid var(--pop-divider);
    background: var(--pop-hover);
  }

  .command-glyph,
  .command-palette kbd {
    border: 1px solid var(--pop-border);
    border-radius: 5px;
    background: var(--pop-hover);
    color: var(--pop-muted);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    line-height: 18px;
  }

  .command-glyph {
    flex: 0 0 auto;
    padding: 0 6px;
  }

  .command-palette input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    font-size: var(--text-base);
  }

  .command-palette input::placeholder {
    color: var(--pop-muted);
  }

  .command-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    scroll-padding-block: 6px;
    scrollbar-color: var(--pop-muted) transparent;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
  }

  .command-action-error {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--pop-divider);
    color: var(--v4-error, #ef4444);
    font-size: var(--text-base);
    line-height: 17px;
  }

  .command-action-error span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .command-action-error button {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentcolor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .command-action-error button:disabled {
    opacity: 0.58;
    cursor: wait;
  }

  .command-section + .command-section {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--pop-divider);
  }

  .command-section-title {
    padding: 5px 8px 4px;
    color: var(--pop-muted);
    font-size: var(--text-micro);
    font-weight: 600;
    line-height: 14px;
    text-transform: uppercase;
  }

  .command-list button,
  .command-empty {
    width: 100%;
    min-height: 46px;
    border-radius: 0;
  }

  .command-list button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 8px;
    border: 0;
    background: transparent;
    color: var(--pop-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
    scroll-margin-block: 6px;
    transition:
      background-color 120ms ease,
      color 120ms ease,
      box-shadow 120ms ease;
  }

  .command-list button:disabled {
    cursor: wait;
  }

  .command-list button:disabled:not([aria-busy='true']) {
    opacity: 0.48;
  }

  .command-list button.highlighted,
  .command-list button:focus-visible {
    background: var(--pop-hover);
    color: var(--pop-text);
    outline: none;
    box-shadow: inset 0 -1px 0 var(--pop-border);
  }

  .command-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
  }

  .command-copy strong,
  .command-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-copy strong {
    color: currentColor;
    font-size: var(--text-base);
    font-weight: 600;
  }

  .command-copy span {
    color: var(--pop-muted);
    font-size: var(--text-base);
  }

  .command-palette kbd {
    flex: 0 0 auto;
    min-width: 22px;
    padding: 0 5px;
    text-align: center;
    transition:
      border-color 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }

  .command-spinner {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    border: 1.5px solid var(--pop-border);
    border-top-color: var(--pop-text);
    border-radius: 50%;
    animation: command-spin 700ms linear infinite;
  }

  .command-list button.highlighted kbd {
    border-color: var(--pop-border);
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .command-empty {
    display: flex;
    align-items: center;
    padding: 0 10px;
    color: var(--pop-muted);
  }

  @media (prefers-reduced-transparency: reduce) {
    .command-backdrop,
    .command-palette {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .command-backdrop {
      background: color-mix(in srgb, var(--c-bg) 74%, transparent);
    }

    .command-palette {
      background: var(--c-bg);
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    .command-backdrop {
      animation: command-backdrop-in 120ms ease-out;
    }

    .command-palette {
      animation: command-palette-in 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
  }

  @keyframes command-backdrop-in {
    from {
      background: rgba(0, 0, 0, 0);
    }
  }

  @keyframes command-palette-in {
    from {
      opacity: 0;
      transform: translateY(-8px) scale(0.985);
    }
  }

  @keyframes command-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .command-spinner {
      animation-duration: 1400ms;
    }
  }
</style>
