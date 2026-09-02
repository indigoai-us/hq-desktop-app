<script lang="ts">
  /**
   * A parked tool-permission request, rendered above the composer.
   *
   * The transcript already carries a `waiting-approval` activity row for this
   * request; this card is the DECISION surface — the row says what is blocked,
   * the card is where the operator unblocks it. Three outcomes, matching the
   * backend's `PermissionDecision`: allow once, allow for the rest of this
   * session, or deny (optionally with a reason the agent reads).
   *
   * Presentation-pure: props in, callbacks out. The card never invokes.
   */
  import type { PermissionSuggestion } from './session-events';

  interface Props {
    requestId: string;
    toolName: string;
    input: unknown;
    suggestions?: PermissionSuggestion[];
    /** Set while a decision is in flight, so the buttons cannot double-fire. */
    busy?: boolean;
    onallowonce?: (requestId: string) => void;
    onallowsession?: (requestId: string) => void;
    ondeny?: (requestId: string, message: string) => void;
  }

  let {
    requestId,
    toolName,
    input,
    suggestions = [],
    busy = false,
    onallowonce,
    onallowsession,
    ondeny,
  }: Props = $props();

  let denyOpen = $state(false);
  let denyReason = $state('');

  /** The most useful single line of a tool input, never the whole payload. */
  const PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt'];
  const PREVIEW_LIMIT = 400;

  function previewOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of PREVIEW_KEYS) {
        const found = record[key];
        if (typeof found === 'string' && found.length > 0) return found;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return value === undefined ? '' : String(value);
  }

  const preview = $derived(previewOf(input));
  const truncated = $derived(preview.length > PREVIEW_LIMIT);
  const previewText = $derived(truncated ? `${preview.slice(0, PREVIEW_LIMIT)}…` : preview);

  function submitDeny() {
    ondeny?.(requestId, denyReason.trim());
    denyReason = '';
    denyOpen = false;
  }
</script>

<section
  class="perm-card"
  data-testid="session-permission-card"
  data-request-id={requestId}
  aria-label={`Permission requested for ${toolName}`}
>
  <header class="perm-head">
    <span class="perm-glyph" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M3.6 6.4V4.8a3.4 3.4 0 0 1 6.8 0v1.6m-8 0h9.2v5.2H2.4V6.4Z"
          stroke="currentColor"
          stroke-width="1.1"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span class="perm-title">Allow <strong>{toolName}</strong>?</span>
    {#if suggestions.length > 0}
      <span class="perm-suggestions">{suggestions.length} suggested rule{suggestions.length === 1 ? '' : 's'}</span>
    {/if}
  </header>

  {#if previewText}
    <pre class="perm-preview" data-testid="session-permission-preview">{previewText}</pre>
  {/if}

  <div class="perm-actions">
    <button
      type="button"
      class="primary"
      disabled={busy}
      data-testid="session-permission-allow-once"
      onclick={() => onallowonce?.(requestId)}
    >
      Allow once
    </button>
    <button
      type="button"
      disabled={busy}
      data-testid="session-permission-allow-session"
      onclick={() => onallowsession?.(requestId)}
    >
      Allow for this session
    </button>
    <button
      type="button"
      class="deny"
      disabled={busy}
      data-testid="session-permission-deny"
      onclick={() => (denyOpen ? submitDeny() : (denyOpen = true))}
    >
      {denyOpen ? 'Send denial' : 'Deny'}
    </button>
  </div>

  {#if denyOpen}
    <div class="perm-deny-reason">
      <label for={`deny-reason-${requestId}`}>Reason (optional — the agent reads it)</label>
      <input
        id={`deny-reason-${requestId}`}
        type="text"
        bind:value={denyReason}
        placeholder="Why not, and what to do instead"
        data-testid="session-permission-deny-reason"
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitDeny();
          }
        }}
      />
    </div>
  {/if}
</section>

<style>
  .perm-card {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    padding: var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-raised);
  }

  .perm-head {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    font-size: var(--type-body);
    color: var(--v4-text-1);
  }

  .perm-glyph {
    display: inline-flex;
    color: var(--v4-text-2);
  }

  .perm-title strong {
    font-weight: 500;
  }

  .perm-suggestions {
    margin-left: auto;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .perm-preview {
    margin: 0;
    max-height: 140px;
    overflow: auto;
    padding: var(--v4-space-2);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--type-metadata);
    line-height: 1.45;
    color: var(--v4-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .perm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-2);
  }

  .perm-actions button {
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

  .perm-actions button:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .perm-actions button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .perm-actions .primary {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .perm-actions .deny {
    color: var(--v4-error, var(--v4-text-1));
  }

  .perm-deny-reason {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .perm-deny-reason label {
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .perm-deny-reason input {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-body);
  }
</style>
