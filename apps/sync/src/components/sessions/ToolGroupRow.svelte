<script lang="ts">
  /**
   * One turn's tool work, folded into a single quiet line.
   *
   * "▸ Ran 8 commands · edited 1 file · read 5 files" — expandable to the
   * individual calls. The collapsed line is the default because the operator
   * is reading a CONVERSATION: what the agent did is context for what it said,
   * not the point of the screen. Everything is still one click away.
   *
   * The row is live: while a call is running it carries a spinner and the
   * summary re-counts on every event, so an agent at work never goes dark.
   *
   * Presentation-pure: props in, no callbacks needed — the disclosure is local
   * state, because whether a row is open is nobody else's business.
   */
  import type { ToolCallSummary } from './transcript-adapter';

  interface Props {
    summary: string;
    calls: ToolCallSummary[];
    running?: boolean;
  }

  let { summary, calls, running = false }: Props = $props();

  let open = $state(false);
</script>

<div class="tool-group" data-testid="session-tool-group" data-running={running ? 'true' : 'false'}>
  <button
    type="button"
    class="tool-summary"
    aria-expanded={open}
    data-testid="session-tool-group-toggle"
    onclick={() => (open = !open)}
  >
    <span class="caret" class:open aria-hidden="true">
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
        <path d="M2.5 1.2 6 4 2.5 6.8Z" fill="currentColor" />
      </svg>
    </span>
    {#if running}
      <span class="spinner" aria-hidden="true"></span>
    {/if}
    <span class="summary-text">{summary}</span>
  </button>

  {#if open}
    <ul class="calls" data-testid="session-tool-calls">
      {#each calls as call (call.id)}
        <li class="call" data-testid="session-tool-call" data-status={call.status}>
          <span class="status" aria-hidden="true">
            {#if call.status === 'running'}
              <span class="spinner"></span>
            {:else if call.status === 'error'}
              ✗
            {:else}
              ✓
            {/if}
          </span>
          <span class="call-name">{call.name}</span>
          <span class="call-detail">{call.detail}</span>
        </li>
        {#if call.outcome || call.output}
          <li class="call-outcome"><pre>{call.outcome || call.output}</pre></li>
        {/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tool-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tool-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    max-width: 100%;
    padding: 2px 6px 2px 2px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: var(--type-metadata);
    text-align: left;
    cursor: pointer;
  }

  .tool-summary:hover {
    color: var(--v4-text-2);
    background: var(--v4-active-row);
  }

  .caret {
    display: inline-flex;
    flex: none;
    transition: transform 120ms ease;
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .summary-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spinner {
    flex: none;
    width: 9px;
    height: 9px;
    border: 1.5px solid var(--v4-text-3);
    border-top-color: transparent;
    border-radius: 50%;
    animation: tool-spin 700ms linear infinite;
  }

  @keyframes tool-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2400ms;
    }
    .caret {
      transition: none;
    }
  }

  .calls {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 4px;
    padding: 0 0 0 16px;
    list-style: none;
  }

  .call {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--v4-text-3);
  }

  .status {
    flex: none;
    width: 10px;
    text-align: center;
  }

  .call[data-status='error'] .status {
    color: var(--v4-error, var(--v4-text-2));
  }

  .call-name {
    flex: none;
    color: var(--v4-text-2);
  }

  .call-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .call-outcome {
    padding-left: 16px;
  }

  .call-outcome pre {
    margin: 0 0 4px;
    max-height: 180px;
    overflow: auto;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.55;
    color: var(--v4-text-3);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
