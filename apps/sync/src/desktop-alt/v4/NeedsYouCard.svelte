<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HomeCardModel } from './home-model';
  import './tokens.css';

  /**
   * V4 inline-action card — the NEEDS YOU queue unit (home-healthy.png) and
   * the error card (home-error.png). Raised surface, compact title + sub,
   * a right-aligned action row (one primary fill, secondary outline, quiet
   * text actions), and an optional extra region (the error card's collapsible
   * "Technical details" inset renders through the snippet).
   *
   * Rows stay open and neutral. Tone is communicated by the section status and
   * action copy, never by a colored card edge or partial border.
   */
  interface Props {
    card: HomeCardModel;
    onaction?: (id: string) => void | Promise<void>;
    children?: Snippet;
  }

  let { card, onaction, children }: Props = $props();
  let pendingActionId = $state<string | null>(null);
  let actionFailure = $state<{ id: string; message: string } | null>(null);

  async function handleAction(id: string): Promise<void> {
    if (!onaction || pendingActionId) return;
    actionFailure = null;
    pendingActionId = id;
    try {
      await onaction(id);
    } catch (err) {
      console.error(`home action ${id} failed`, err);
      actionFailure = {
        id,
        message: 'That action didn’t complete.',
      };
    } finally {
      pendingActionId = null;
    }
  }
</script>

<div class={`v4-card ${card.tone}`} data-testid="needs-you-card">
  <div class="v4-card-row">
    <div class="v4-card-copy">
      <p class="v4-card-title">{card.title}</p>
      {#if card.sub}
        <p class="v4-card-sub">{card.sub}</p>
      {/if}
    </div>
    {#if card.actions.length > 0}
      <div class="v4-card-actions">
        {#each card.actions as action (action.id)}
          <button
            type="button"
            class={`v4-card-action ${action.kind}`}
            disabled={action.disabled || pendingActionId !== null}
            aria-busy={pendingActionId === action.id}
            onclick={() => void handleAction(action.id)}
          >
            {pendingActionId === action.id ? `${action.label}…` : action.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {#if children}
    {@render children()}
  {/if}
  {#if actionFailure}
    <div class="v4-card-error" role="alert">
      <span>{actionFailure.message}</span>
      <button
        type="button"
        onclick={() => void handleAction(actionFailure!.id)}
        disabled={pendingActionId !== null}
        aria-busy={pendingActionId === actionFailure.id}
      >
        {pendingActionId === actionFailure.id ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  {/if}
</div>

<style>
  .v4-card {
    padding: 12px 0;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .v4-card.warn,
  .v4-card.error {
    border-color: var(--v4-rowline);
  }

  .v4-card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .v4-card-copy {
    min-width: 0;
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .v4-card-title {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .v4-card-sub {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.4;
  }

  .v4-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .v4-card-action {
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    line-height: 16px;
    white-space: nowrap;
    cursor: pointer;
  }

  .v4-card-action.primary {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .v4-card-action.secondary {
    border-color: var(--v4-control-border);
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
  }

  .v4-card-action.text {
    color: var(--v4-text-2);
  }

  .v4-card-action:hover:not(:disabled) {
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
  }

  .v4-card-action.primary:hover:not(:disabled) {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    opacity: 0.86;
  }

  .v4-card-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .v4-card-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--v4-error);
    font-size: var(--type-metadata, var(--text-micro));
  }

  .v4-card-error button {
    padding: 0;
    border: 0;
    background: transparent;
    color: currentColor;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
</style>
