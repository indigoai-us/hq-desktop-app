<script lang="ts">
  /**
   * The strip's "⋯" — the three things you can do to a session that are not
   * a message: reopen it in its own CLI, share it to a channel, end it.
   *
   * Labelled by the session's tool ("Open in Claude Code" / "Open in Codex")
   * and disabled as a whole when there is no live session, so the menu never
   * offers an action with nothing to act on. Presentation-pure: it reports a
   * click and closes; the page decides what the click does, and the share
   * item only OPENS a dialog — nothing outward happens until that dialog's
   * own confirm.
   *
   * Closes on Escape or a click outside, the same way the policies chip does.
   */
  import type { SessionTool } from '../../desktop-alt/lib/live-session-store.svelte';

  interface Props {
    tool?: SessionTool;
    /** No live session — the trigger is rendered but inert. */
    disabled?: boolean;
    onopeninapp?: () => void;
    onshare?: () => void;
    onend?: () => void;
  }

  let { tool = 'claude', disabled = false, onopeninapp, onshare, onend }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);

  const openLabel = $derived(tool === 'codex' ? 'Open in Codex' : 'Open in Claude Code');

  function onWindowClick(event: MouseEvent) {
    if (!open) return;
    const target = event.target;
    if (root && target instanceof Node && root.contains(target)) return;
    open = false;
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) open = false;
  }

  function pick(action: (() => void) | undefined) {
    open = false;
    action?.();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="menu" bind:this={root} data-testid="session-menu">
  <button
    type="button"
    class="trigger"
    aria-label="Session actions"
    aria-haspopup="menu"
    aria-expanded={open}
    {disabled}
    data-testid="session-menu-trigger"
    onclick={() => (open = !open)}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11.5" cy="7" r="1.3" />
    </svg>
  </button>

  {#if open}
    <div class="popover" role="menu" aria-label="Session actions" data-testid="session-menu-popover">
      <button
        type="button"
        class="item"
        role="menuitem"
        data-testid="session-menu-open-in-app"
        onclick={() => pick(onopeninapp)}
      >
        {openLabel}
      </button>
      <button
        type="button"
        class="item"
        role="menuitem"
        data-testid="session-menu-share"
        onclick={() => pick(onshare)}
      >
        Share to channel…
      </button>
      <div class="rule" role="separator"></div>
      <button
        type="button"
        class="item end"
        role="menuitem"
        data-testid="session-menu-end"
        onclick={() => pick(onend)}
      >
        End session
      </button>
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
    display: inline-flex;
    flex: none;
  }

  .trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }

  .trigger:hover:not(:disabled),
  .trigger[aria-expanded='true'] {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .trigger:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 4px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card, 8px);
    background: var(--v4-surface, var(--pop-bg, #fff));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  .item {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .item:hover,
  .item:focus-visible {
    background: var(--v4-active-row);
  }

  .item.end {
    color: var(--v4-text-2);
  }

  .rule {
    height: 1px;
    margin: 4px 2px;
    background: var(--v4-hairline);
  }
</style>
