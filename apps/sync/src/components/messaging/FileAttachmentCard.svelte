<script lang="ts">
  // File attachment card for the channel timeline (US-004).
  // Deep-links toward the Files tab (US-008). Until that lands, the click
  // no-ops gracefully — dispatches an unhandled custom event and never throws.
  import type { FileAttachmentModel } from './channelMessageModels';

  interface Props {
    model: FileAttachmentModel;
    /** Optional host hook; default is a safe no-op deep-link stub. */
    onopen?: (model: FileAttachmentModel) => void;
  }

  let { model, onopen }: Props = $props();

  function handleOpen(): void {
    try {
      onopen?.(model);
      // Graceful deep-link stub for the future Files tab (US-008). Unhandled
      // listeners are fine — this must never throw.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('hq:open-file-attachment', {
            detail: {
              vaultPath: model.vaultPath,
              name: model.name,
            },
            bubbles: true,
          }),
        );
      }
    } catch (err) {
      console.error('file-attachment-card: open handler failed', err);
    }
  }
</script>

<button
  type="button"
  class="file-card"
  data-testid="file-attachment-card"
  onclick={handleOpen}
  title={model.vaultPath || model.name}
>
  <span class="file-card-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      <path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    </svg>
  </span>
  <span class="file-card-copy">
    <span class="file-card-name">{model.name}</span>
    <span class="file-card-caption">{model.caption}</span>
  </span>
</button>

<style>
  .file-card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(320px, 100%);
    margin: 0.25rem 0;
    padding: 8px 12px;
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 10px;
    background: var(--raised, var(--pop-hover));
    color: var(--t1, var(--pop-text));
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .file-card:hover {
    background: var(--raised, var(--c-field-bg));
    border-color: var(--line2, var(--pop-border));
  }

  .file-card:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: 1px;
  }

  .file-card-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
  }

  .file-card-copy {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .file-card-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--t1, var(--pop-text));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-card-caption {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 10px;
    font-weight: 400;
    color: var(--t2, var(--pop-muted));
  }
</style>
