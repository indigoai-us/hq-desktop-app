<script lang="ts">
  /**
   * The session composer: one auto-sizing textarea, Enter to send,
   * Shift+Enter for a newline, `/` command autocomplete, and a Stop button
   * while a turn is in flight.
   *
   * Sending WHILE the agent is working is allowed on purpose — that is
   * steering, and the backend accepts a mid-turn user line. So `working` never
   * disables the textarea; it only adds Stop beside Send.
   *
   * All autocomplete decisions come from the pure helpers in
   * `./slash-commands`; this component owns only the DOM and the keyboard.
   */
  import { filterSlashCommands, applySlashCommand } from './slash-commands';
  import type { SessionCommand } from './session-events';

  interface Props {
    /** Merged slash-command catalog (probe + the session's own `started` list). */
    commands?: SessionCommand[];
    /** True while the agent is mid-turn — enables Stop, never disables input. */
    working?: boolean;
    /** True when there is no live session to send to. */
    disabled?: boolean;
    placeholder?: string;
    onsend?: (text: string) => void;
    onstop?: () => void;
  }

  let {
    commands = [],
    working = false,
    disabled = false,
    placeholder = 'Message the agent — Enter to send, Shift+Enter for a newline',
    onsend,
    onstop,
  }: Props = $props();

  let draft = $state('');
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let highlighted = $state(0);
  /** Dismissed with Escape; re-armed as soon as the draft changes. */
  let suppressed = $state(false);
  let lastDraft = $state('');

  const matches = $derived(suppressed ? [] : filterSlashCommands(draft, commands));
  const menuOpen = $derived(matches.length > 0);
  const safeIndex = $derived(
    matches.length === 0 ? 0 : Math.min(Math.max(highlighted, 0), matches.length - 1),
  );

  /** Grow the textarea with its content, up to a bounded height. */
  const MAX_ROWS_PX = 200;
  $effect(() => {
    // Touch `draft` so the effect re-runs on every keystroke.
    void draft;
    const el = textarea;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  });

  // A changed draft re-arms a menu the user dismissed with Escape, and resets
  // the highlight to the best match.
  $effect(() => {
    if (draft === lastDraft) return;
    lastDraft = draft;
    suppressed = false;
    highlighted = 0;
  });

  function pick(command: SessionCommand) {
    draft = applySlashCommand(draft, command);
    suppressed = true;
    textarea?.focus();
  }

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onsend?.(text);
    draft = '';
    suppressed = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlighted = (safeIndex + 1) % matches.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlighted = (safeIndex - 1 + matches.length) % matches.length;
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const chosen = matches[safeIndex];
        if (chosen) pick(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        suppressed = true;
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="composer" data-testid="session-composer">
  {#if menuOpen}
    <ul class="slash-menu" role="listbox" aria-label="Slash commands" data-testid="session-slash-menu">
      {#each matches as command, index (command.name)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === safeIndex}
            class="slash-item"
            class:highlighted={index === safeIndex}
            data-testid="session-slash-item"
            onmouseenter={() => (highlighted = index)}
            onclick={() => pick(command)}
          >
            <span class="slash-name">/{command.name}</span>
            {#if command.argumentHint}
              <span class="slash-args">{command.argumentHint}</span>
            {/if}
            {#if command.description}
              <span class="slash-description">{command.description}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="composer-box">
    <textarea
      bind:this={textarea}
      bind:value={draft}
      class="composer-input"
      rows="1"
      {placeholder}
      {disabled}
      aria-label="Message the agent"
      data-testid="session-composer-input"
      onkeydown={onKeydown}
    ></textarea>

    <div class="composer-actions">
      {#if working}
        <button
          type="button"
          class="stop"
          data-testid="session-composer-stop"
          onclick={() => onstop?.()}
        >
          Stop
        </button>
      {/if}
      <button
        type="button"
        class="send"
        disabled={disabled || draft.trim().length === 0}
        data-testid="session-composer-send"
        onclick={submit}
      >
        Send
      </button>
    </div>
  </div>

  {#if working}
    <p class="composer-hint" data-testid="session-composer-steer-hint">
      The agent is working — sending now steers the turn in progress.
    </p>
  {/if}
</div>

<style>
  .composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .composer-box {
    display: flex;
    align-items: flex-end;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-raised);
  }

  .composer-input {
    flex: 1;
    min-width: 0;
    max-height: 200px;
    resize: none;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-body);
    line-height: 1.45;
  }

  .composer-input::placeholder {
    color: var(--v4-text-3);
  }

  .composer-actions {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
  }

  .composer-actions button {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-raised);
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .composer-actions .send {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .composer-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .composer-hint {
    margin: 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .slash-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 260px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-popover, var(--v4-raised));
    box-shadow: var(--v4-shadow-popover, none);
  }

  .slash-item {
    display: flex;
    align-items: baseline;
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

  .slash-item.highlighted {
    background: var(--v4-active-row);
  }

  .slash-name {
    font-family: var(--font-mono, ui-monospace, monospace);
    flex: none;
  }

  .slash-args {
    color: var(--v4-text-3);
    flex: none;
  }

  .slash-description {
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
