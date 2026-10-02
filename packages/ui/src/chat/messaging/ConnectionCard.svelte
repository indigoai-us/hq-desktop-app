<script lang="ts">
  /**
   * One connection card (Slack, or Connect your tools) inside a bot's message.
   *
   * Drawn entirely from a view the app built (connection-card-model.ts): the
   * title, the line, the buttons and the note are the app's own words, bound
   * as text. Nothing here comes from the bot, and a press never opens a link
   * by itself. It tells the host which button was pressed and the host decides
   * what to open.
   *
   * A pressed button is disabled at once and stays so until the host has
   * handled the press, so a double click acts once.
   */
  import { onDestroy } from "svelte";
  import {
    connectionActionKey,
    type ConnectionCardAction,
    type ConnectionCardActionHandler,
    type ConnectionCardView,
  } from "./connection-card-model.js";

  interface Props {
    view: ConnectionCardView;
    onaction?: ConnectionCardActionHandler;
  }

  let { view, onaction }: Props = $props();

  /** Shortest time a pressed button stays disabled: longer than a double click. */
  const PRESS_HOLD_MS = 600;

  // Presses the host has not finished handling, by action key.
  let pressed = $state<Record<string, true>>({});
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onDestroy(() => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });

  function isPressed(action: ConnectionCardAction, connectionId?: string): boolean {
    return connectionActionKey(view.target, action, connectionId) in pressed;
  }

  function release(key: string): void {
    const { [key]: _done, ...rest } = pressed;
    pressed = rest;
  }

  function press(action: ConnectionCardAction, connectionId?: string): void {
    const key = connectionActionKey(view.target, action, connectionId);
    if (key in pressed) return;
    pressed = { ...pressed, [key]: true };
    const startedAt = Date.now();
    const done = (): void => {
      const wait = Math.max(0, PRESS_HOLD_MS - (Date.now() - startedAt));
      const timer = setTimeout(() => {
        timers.delete(timer);
        release(key);
      }, wait);
      timers.add(timer);
    };
    let result: void | Promise<void>;
    try {
      result = onaction?.({ target: view.target, action, ...(connectionId ? { connectionId } : {}) });
    } catch {
      done();
      return;
    }
    void Promise.resolve(result).then(done, done);
  }
</script>

<div
  class="connection-card"
  data-testid="connection-card"
  data-target={view.target}
  data-state={view.state}
  role="group"
  aria-label={view.title}
>
  <div class="connection-card-head">
    <span class="connection-card-icon" aria-hidden="true">
      {#if view.target === "slack"}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11" />
        </svg>
      {:else}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0zM8 11.5v3" />
        </svg>
      {/if}
    </span>
    <span class="connection-card-title">{view.title}</span>
    {#if view.mark}
      <span class="connection-card-mark" data-testid="connection-card-mark">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.5 11L3.5 8l1-1 2 2 5-5 1 1z" fill="currentColor" /></svg>
        {view.mark}
      </span>
    {/if}
  </div>
  <div class="connection-card-line" data-testid="connection-card-line">{view.line}</div>
  {#if view.waiting.length > 0}
    <ul class="connection-card-rows">
      {#each view.waiting as row (row.connectionId)}
        <li class="connection-card-row" data-testid="connection-card-row" data-connection-id={row.connectionId}>
          <span class="connection-card-row-name">{row.name}</span>
          <button
            type="button"
            class="connection-card-btn"
            data-testid="connection-card-allow"
            disabled={row.pending || isPressed("allow", row.connectionId)}
            onclick={() => press("allow", row.connectionId)}
          >
            {row.label}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if view.moreWaiting}
    <div class="connection-card-more" data-testid="connection-card-more">{view.moreWaiting}</div>
  {/if}
  {#if view.primaryLabel || view.declineLabel}
    <div class="connection-card-actions">
      {#if view.primaryLabel}
        <button
          type="button"
          class="connection-card-btn is-primary"
          data-testid="connection-card-primary"
          disabled={view.primaryPending || isPressed("connect")}
          onclick={() => press("connect")}
        >
          {view.primaryLabel}
        </button>
      {/if}
      {#if view.declineLabel}
        <button
          type="button"
          class="connection-card-btn is-quiet"
          data-testid="connection-card-decline"
          disabled={isPressed("decline")}
          onclick={() => press("decline")}
        >
          {view.declineLabel}
        </button>
      {/if}
    </div>
  {/if}
  {#if view.note}
    <div class="connection-card-note" data-testid="connection-card-note" role="status">{view.note}</div>
  {/if}
</div>

<style>
  /* Same tokens as the decision block, so light and dark both work. */
  .connection-card {
    flex: 1 1 220px;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 8px;
    font-size: 13px;
    color: var(--t1, var(--pop-text));
  }
  .connection-card[data-state="connecting"] {
    border-color: var(--vio-ink);
    background: color-mix(in srgb, var(--vio-ink) 8%, transparent);
  }
  .connection-card[data-state="connected"] {
    border-color: color-mix(in srgb, var(--ok-ink, #248a3d) 32%, transparent);
    background: color-mix(in srgb, var(--ok-ink, #248a3d) 8%, transparent);
  }
  .connection-card[data-state="declined"] {
    border-style: dashed;
    color: var(--t3, var(--pop-muted));
  }
  .connection-card-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .connection-card-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--t2, var(--pop-muted));
  }
  .connection-card[data-state="connecting"] .connection-card-icon {
    color: var(--vio-ink);
  }
  .connection-card[data-state="connected"] .connection-card-icon {
    color: var(--ok-ink, #248a3d);
  }
  .connection-card-title {
    font-weight: 600;
  }
  .connection-card-mark {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ok-ink, #248a3d);
    white-space: nowrap;
  }
  .connection-card-line {
    font-size: 12px;
    line-height: 1.45;
    color: var(--t2, var(--pop-muted));
  }
  .connection-card[data-state="declined"] .connection-card-line {
    color: var(--t3, var(--pop-muted));
  }
  .connection-card-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .connection-card-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 8px;
  }
  .connection-card-row-name {
    font-weight: 500;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .connection-card-more {
    font-size: 12px;
    color: var(--t3, var(--pop-muted));
  }
  .connection-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: auto;
  }
  .connection-card-btn {
    padding: 6px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    color: var(--t1, var(--pop-text));
    background: var(--pop-surface, transparent);
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .connection-card-btn:hover:not(:disabled) {
    border-color: var(--vio-ink);
  }
  .connection-card-btn:focus-visible {
    outline: 2px solid var(--vio-ink);
    outline-offset: 1px;
  }
  .connection-card-btn.is-primary {
    border-color: var(--vio-ink);
    background: color-mix(in srgb, var(--vio-ink) 8%, transparent);
  }
  .connection-card-btn.is-quiet {
    border-color: transparent;
    background: transparent;
    color: var(--t2, var(--pop-muted));
  }
  .connection-card-btn:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .connection-card-note {
    font-size: 12px;
    line-height: 1.4;
    color: var(--warn-ink, #b45309);
  }
</style>
