<script lang="ts">
  export type HomeQuickActionId =
    | 'start-work'
    | 'search-hq'
    | 'run-worker'
    | 'capture-idea'
    | 'plan-project';

  interface Props {
    onaction?: (id: HomeQuickActionId) => void;
  }

  let { onaction }: Props = $props();

  const actions: Array<{
    id: HomeQuickActionId;
    symbol: string;
    label: string;
    detail: string;
  }> = [
    { id: 'start-work', symbol: '↗', label: 'Start work', detail: 'Route into the right repo or project' },
    { id: 'search-hq', symbol: '⌕', label: 'Search HQ', detail: 'Find a file, decision, or signal' },
    { id: 'run-worker', symbol: '◇', label: 'Run a worker', detail: 'Hand work to a specialist' },
    { id: 'capture-idea', symbol: '+', label: 'Capture idea', detail: 'Save an idea without breaking flow' },
    { id: 'plan-project', symbol: '≡', label: 'Plan project', detail: 'Turn an outcome into executable work' },
  ];
</script>

<section class="quick-actions" aria-labelledby="quick-actions-title">
  <div class="quick-actions-heading">
    <h2 id="quick-actions-title">Move work forward</h2>
    <span>Opens in Claude Code with the right HQ workflow</span>
  </div>
  <div class="quick-action-grid" role="toolbar" aria-label="HQ quick actions">
    {#each actions as action (action.id)}
      <button type="button" onclick={() => onaction?.(action.id)}>
        <span class="quick-action-symbol" aria-hidden="true">{action.symbol}</span>
        <span class="quick-action-copy">
          <strong>{action.label}</strong>
          <span>{action.detail}</span>
        </span>
        <span class="quick-action-arrow" aria-hidden="true">›</span>
      </button>
    {/each}
  </div>
</section>

<style>
  .quick-actions {
    display: grid;
    gap: 8px;
  }

  .quick-actions-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }

  .quick-actions-heading h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.3;
  }

  .quick-actions-heading span {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-action-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-raised);
    box-shadow: var(--v4-shadow-card);
  }

  .quick-action-grid button {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) 12px;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 60px;
    padding: 9px 10px;
    border: 0;
    border-left: 1px solid var(--v4-rowline);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .quick-action-grid button:first-child {
    border-left: 0;
  }

  .quick-action-grid button:hover,
  .quick-action-grid button:focus-visible {
    background: var(--v4-active-row);
  }

  .quick-action-grid button:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--v4-text-1);
    outline-offset: -2px;
  }

  .quick-action-symbol {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--v4-control-border);
    border-radius: 7px;
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font-size: 13px;
  }

  .quick-action-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .quick-action-copy strong,
  .quick-action-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-action-copy strong {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 500;
  }

  .quick-action-copy span,
  .quick-action-arrow {
    color: var(--v4-text-3);
    font-size: var(--text-xs);
  }

  @container home (max-width: 820px) {
    .quick-action-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .quick-action-grid button:nth-child(odd) {
      border-left: 0;
    }

    .quick-action-grid button:nth-child(n + 3) {
      border-top: 1px solid var(--v4-rowline);
    }
  }
</style>
