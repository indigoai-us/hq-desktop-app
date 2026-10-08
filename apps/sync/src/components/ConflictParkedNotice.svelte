<script lang="ts">
  import type { ConflictParkedNotice } from '../lib/conflictNotices';

  interface Props {
    notices: readonly ConflictParkedNotice[];
    busyIds: ReadonlySet<string>;
    onShowInFinder: (notice: ConflictParkedNotice) => void;
    onAcknowledge: (notice: ConflictParkedNotice) => void;
  }

  let { notices, busyIds, onShowInFinder, onAcknowledge }: Props = $props();
</script>

{#if notices.length > 0}
  <section class="conflict-notices" data-testid="conflict-parked-notices" role="status" aria-live="polite">
    {#each notices as notice (notice.id)}
      <article class="conflict-notice" data-testid="conflict-parked-notice">
        <div class="copy">
          <strong>Conflict copy parked</strong>
          <p><span class="path">{notice.relativePath}</span> has a preserved copy.</p>
        </div>
        <div class="actions">
          <button type="button" class="show" disabled={busyIds.has(notice.id)} onclick={() => onShowInFinder(notice)}>
            {busyIds.has(notice.id) ? 'Opening…' : 'Show in Finder'}
          </button>
          <button type="button" class="dismiss" disabled={busyIds.has(notice.id)} aria-label={`Acknowledge ${notice.relativePath}`} onclick={() => onAcknowledge(notice)}>
            {busyIds.has(notice.id) ? 'Saving…' : 'Dismiss'}
          </button>
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .conflict-notices {
    display: grid;
    gap: 8px;
    flex: 0 0 auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--v4-line, color-mix(in srgb, currentColor 12%, transparent));
    background: var(--v4-reading-surface, var(--surface));
    color: var(--v4-ink, var(--text));
  }

  .conflict-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
  }

  .copy { min-width: 0; }
  .copy strong { font-size: 13px; font-weight: 600; }
  .copy p { margin: 2px 0 0; color: var(--v4-muted-ink, var(--muted)); font-size: 12px; }
  .path { overflow-wrap: anywhere; }
  .actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
  button {
    min-height: 30px;
    border: 1px solid var(--v4-line, color-mix(in srgb, currentColor 18%, transparent));
    border-radius: 6px;
    padding: 4px 10px;
    color: inherit;
    background: var(--v4-control-surface, transparent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button.show { font-weight: 600; }
  button:disabled { cursor: wait; opacity: 0.65; }
  button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }

  @media (max-width: 580px) {
    .conflict-notice { align-items: flex-start; flex-direction: column; gap: 8px; }
  }
</style>
