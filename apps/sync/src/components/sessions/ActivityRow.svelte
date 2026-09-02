<script lang="ts">
  // US-025 Phase 2: one activity item in verb → object → outcome framing
  // (VISION_ACTIVITY twelve-class taxonomy). Salience tracks consequence:
  // errors are loud (--v4-error edge), thoughts/suppressed/raw recede,
  // the spine reads at body weight. Waiting, timed-out, and executing are
  // rendered states — agents never go dark. Raw-rail rows carry a collapsed
  // ground-truth expander.
  import { formatTime } from './session-types';
  import type { WsActivityItem } from './session-types';

  interface Props {
    item: WsActivityItem;
    onapprove?: (itemId: string) => void;
    ondeny?: (itemId: string) => void;
  }

  let { item, onapprove, ondeny }: Props = $props();

  // Floor + thought classes render quiet; the error class renders loud.
  const quiet = $derived(
    item.cls === 'thought' || item.cls === 'suppressed' || item.cls === 'raw-rail',
  );
  const loud = $derived(item.cls === 'error' || item.status === 'failed');
  const mono = $derived(
    item.cls === 'file-edit' || item.cls === 'shell-command' || item.cls === 'generic-tool',
  );

  let rawOpen = $state(false);

  // Class glyphs — small, achromatic, silhouette-first.
  const GLYPHS: Record<string, string> = {
    message: 'M2 3.4A1.4 1.4 0 0 1 3.4 2h7.2A1.4 1.4 0 0 1 12 3.4v4.8a1.4 1.4 0 0 1-1.4 1.4H6l-2.6 2.3V9.6h-.1A1.4 1.4 0 0 1 2 8.2V3.4Z',
    'relay-op': 'M7 1.8v10.4M7 1.8 3.8 5M7 1.8 10.2 5m-6.4 4.2L7 12.2 10.2 9.2',
    'file-edit': 'M8.5 1.8h-5a1 1 0 0 0-1 1v8.4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5l-3-3.2Zm0 0V5h3',
    'shell-command': 'M2.4 3.6 5.6 7l-3.2 3.4M7.4 10.6h4.2',
    'tool-status': 'M7 2.2a4.8 4.8 0 1 1-4.6 3.4M7 4.6V7l1.8 1.2',
    thought: 'M4.4 9.8a3.8 3.8 0 1 1 5.2 0M5.6 12h2.8',
    plan: 'M4.4 3.4h7.2M4.4 7h7.2M4.4 10.6h4.4M2.2 3.4h.01M2.2 7h.01M2.2 10.6h.01',
    permission: 'M3.6 6.4V4.8a3.4 3.4 0 0 1 6.8 0v1.6m-8 0h9.2v5.2H2.4V6.4Z',
    error: 'M7 1.6 13 12H1L7 1.6Zm0 4v3m0 2v.01',
    'generic-tool': 'M9.8 2.4a3 3 0 0 0-3.9 3.9L2.2 10a1.3 1.3 0 0 0 1.8 1.8l3.7-3.7a3 3 0 0 0 3.9-3.9L9.5 6.3 7.7 4.5l2.1-2.1Z',
    'raw-rail': 'M2.4 3h9.2M2.4 5.6h9.2M2.4 8.2h6M2.4 10.8h4',
    suppressed: 'M2.2 7h9.6M7 7h.01',
  };
</script>

<div
  class="ws-activity-row"
  class:quiet
  class:loud
  data-testid="ws-activity-row"
  data-cls={item.cls}
  data-status={item.status}
>
  <span class="glyph" aria-hidden="true">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d={GLYPHS[item.cls]}
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>

  <div class="main">
    <div class="sentence">
      <span class="verb">{item.verb}</span>
      <span class="object" class:mono>{item.object}</span>
      {#if item.outcome}
        <span class="arrow" aria-hidden="true">→</span>
        <span class="outcome">{item.outcome}</span>
      {/if}
    </div>

    {#if item.status === 'executing'}
      <div class="lifecycle" data-testid="ws-activity-lifecycle" aria-label="pending, then executing, then done">
        <span class="step past">pending</span>
        <span class="step-arrow" aria-hidden="true">→</span>
        <span class="step current">
          <span class="exec-spinner" aria-hidden="true"></span>
          executing
        </span>
        <span class="step-arrow" aria-hidden="true">→</span>
        <span class="step future">done</span>
      </div>
    {:else if item.status === 'waiting-approval'}
      <div class="wait-row" data-testid="ws-activity-waiting">
        <span class="wait-dot" aria-hidden="true"></span>
        Waiting on approval — the agent stays paused, not silent.
        <button type="button" class="mini approve" onclick={() => onapprove?.(item.id)}>Approve</button>
        <button type="button" class="mini" onclick={() => ondeny?.(item.id)}>Deny</button>
      </div>
    {:else if item.status === 'timed-out'}
      <div class="wait-row timed-out" data-testid="ws-activity-timeout">
        <span class="wait-dot hollow" aria-hidden="true"></span>
        Timed out — rendered, never dark. The agent reports the stall and retries.
      </div>
    {/if}

    {#if item.detail && item.cls !== 'raw-rail'}
      <p class="detail">{item.detail}</p>
    {/if}

    {#if item.cls === 'raw-rail'}
      <button
        type="button"
        class="raw-toggle"
        aria-expanded={rawOpen}
        data-testid="ws-activity-raw-toggle"
        onclick={() => (rawOpen = !rawOpen)}
      >
        <span class="raw-chevron" class:open={rawOpen} aria-hidden="true">›</span>
        {rawOpen ? 'Hide raw events' : `Show raw events (${item.object})`}
      </button>
      {#if rawOpen && item.raw}
        <pre class="raw" data-testid="ws-activity-raw">{item.raw}</pre>
      {/if}
    {/if}
  </div>

  <span class="time">{formatTime(item.createdAt)}</span>
</div>

<style>
  .ws-activity-row {
    display: flex;
    align-items: flex-start;
    gap: var(--v4-space-3);
    padding: var(--v4-space-2) var(--v4-space-4);
    border-radius: var(--v4-radius-card);
  }

  .ws-activity-row:hover {
    background: var(--v4-control-faint);
  }

  /* DESKTOP-018: a loud row carries its meaning in the tinted wash and the
     error-toned glyph + outcome text, never in a colored partial edge. */
  .ws-activity-row.loud {
    background: color-mix(in srgb, var(--v4-error) 5%, transparent);
  }

  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 24px;
    height: 24px;
    margin-top: 1px;
    border: 1px solid var(--v4-rowline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
  }

  .quiet .glyph {
    border-color: transparent;
    background: none;
    color: var(--v4-text-3);
  }

  .loud .glyph {
    color: var(--v4-error);
    border-color: color-mix(in srgb, var(--v4-error) 30%, transparent);
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .sentence {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 5px;
    font-size: var(--type-body);
    line-height: 1.45;
  }

  .quiet .sentence {
    font-size: var(--type-metadata);
  }

  .verb {
    color: var(--v4-text-2);
  }

  .quiet .verb,
  .quiet .outcome {
    color: var(--v4-text-3);
  }

  .object {
    font-weight: 500;
    color: var(--v4-text-1);
    overflow-wrap: anywhere;
  }

  .quiet .object {
    font-weight: 400;
    color: var(--v4-text-2);
  }

  .object.mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.92em;
  }

  .arrow {
    color: var(--v4-idle);
  }

  .outcome {
    color: var(--v4-text-2);
  }

  .loud .outcome {
    color: var(--v4-error);
    font-weight: 500;
  }

  .lifecycle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .step {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: var(--v4-radius-pill);
    border: 1px solid transparent;
  }

  .step.past {
    color: var(--v4-text-3);
    text-decoration: line-through;
  }

  .step.current {
    border-color: var(--v4-control-border);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }

  .step.future {
    color: var(--v4-idle);
    border-color: var(--v4-rowline);
    border-style: dashed;
  }

  .step-arrow {
    color: var(--v4-idle);
  }

  .exec-spinner {
    width: 9px;
    height: 9px;
    flex: none;
    border: 1.5px solid var(--v4-hairline);
    border-top-color: var(--v4-text-1);
    border-radius: 50%;
    animation: ws-act-spin 0.9s linear infinite;
  }

  @keyframes ws-act-spin {
    100% {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .exec-spinner {
      animation: none;
    }
  }

  .wait-row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    font-size: var(--type-metadata);
    color: var(--v4-warn);
  }

  .wait-row.timed-out {
    color: var(--v4-text-3);
  }

  .wait-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--v4-warn);
  }

  .wait-dot.hollow {
    background: transparent;
    border: 1.5px solid var(--v4-idle);
  }

  .mini {
    height: 22px;
    padding: 0 var(--v4-space-2);
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .mini.approve {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .detail {
    margin: 0;
    font-size: var(--type-metadata);
    line-height: 1.4;
    color: var(--v4-text-3);
  }

  .raw-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    padding: 2px var(--v4-space-2) 2px 0;
    border: none;
    background: none;
    font-family: inherit;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
    cursor: pointer;
  }

  .raw-toggle:hover {
    color: var(--v4-text-1);
  }

  .raw-chevron {
    display: inline-block;
    transition: transform 0.12s ease;
  }

  .raw-chevron.open {
    transform: rotate(90deg);
  }

  .raw {
    margin: 2px 0 0;
    padding: var(--v4-space-2) var(--v4-space-3);
    border: 1px solid var(--v4-rowline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-inset);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.5;
    color: var(--v4-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .time {
    flex: none;
    margin-top: 2px;
    font-size: 11px;
    color: var(--v4-idle);
    font-variant-numeric: tabular-nums;
  }
</style>
