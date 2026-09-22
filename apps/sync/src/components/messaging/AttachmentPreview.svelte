<script lang="ts">
  /**
   * In-app preview for one attachment in a share, with previous/next.
   * Images, PDFs, and text/markdown render inline via a presigned GET.
   * Other types show metadata and Open in Files.
   */
  import {
    attachmentTypeBadge,
    formatAttachmentSize,
    type MessageAttachment,
  } from '../../lib/messageAttachments';
  import {
    ATTACHMENT_MISSING_COMPANY,
    loadAttachmentPreview,
    type AttachmentPreviewView,
  } from '../../lib/attachmentPresign';
  import { renderMessageBodyMarkdown } from '../../lib/messageMarkdown';

  interface Props {
    attachments: MessageAttachment[];
    index: number;
    onclose: () => void;
    onindex: (index: number) => void;
    onopeninfiles: (attachment: MessageAttachment) => void;
    loadPreview?: (attachment: MessageAttachment) => Promise<AttachmentPreviewView>;
  }

  let {
    attachments,
    index,
    onclose,
    onindex,
    onopeninfiles,
    loadPreview = loadAttachmentPreview,
  }: Props = $props();

  const FOCUSABLE =
    'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

  let panelEl = $state<HTMLDivElement | null>(null);
  let loading = $state(false);
  let view = $state<AttachmentPreviewView | null>(null);

  const current = $derived(attachments[index] ?? null);
  const canPrev = $derived(index > 0);
  const canNext = $derived(index < attachments.length - 1);
  const positionLabel = $derived(
    attachments.length === 0 ? '' : `${index + 1} of ${attachments.length}`,
  );

  function portal(node: HTMLElement) {
    const host =
      document.querySelector<HTMLElement>('.desktop-shell') ?? document.body;
    host.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function focusables(): HTMLElement[] {
    if (!panelEl) return [];
    return [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
    );
  }

  function trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      panelEl?.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === panelEl)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (active && !panelEl?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  function goPrev(): void {
    if (canPrev) onindex(index - 1);
  }

  function goNext(): void {
    if (canNext) onindex(index + 1);
  }

  function onPanelKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goPrev();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goNext();
      return;
    }
    trapTab(event);
  }

  function onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onclose();
  }

  function openInFiles(): void {
    if (!current) return;
    if (!(current.companyUid ?? '').trim()) {
      revoke(view);
      view = { kind: 'error', message: ATTACHMENT_MISSING_COMPANY };
      return;
    }
    onopeninfiles(current);
  }

  function revoke(payload: AttachmentPreviewView | null): void {
    if (payload?.kind === 'image' || payload?.kind === 'pdf') {
      URL.revokeObjectURL(payload.objectUrl);
    }
  }

  $effect(() => {
    panelEl?.focus();
  });

  $effect(() => {
    const attachment = current;
    const loader = loadPreview;
    view = null;
    if (!attachment) {
      loading = false;
      return;
    }
    loading = true;
    let cancelled = false;
    let held: AttachmentPreviewView | null = null;
    void loader(attachment).then((result) => {
      if (cancelled) {
        revoke(result);
        return;
      }
      held = result;
      view = result;
      loading = false;
    });
    return () => {
      cancelled = true;
      revoke(held);
    };
  });

  const markdownHtml = $derived(
    view?.kind === 'markdown' ? renderMessageBodyMarkdown(view.text) : '',
  );
  const sizeLabel = $derived(current ? formatAttachmentSize(current.sizeBytes) : '');
  const typeLabel = $derived(current ? attachmentTypeBadge(current) : 'FILE');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="preview-backdrop"
  data-testid="attachment-preview"
  role="presentation"
  use:portal
  onclick={onBackdropClick}
>
  <div
    class="preview-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="attachment-preview-title"
    tabindex="-1"
    bind:this={panelEl}
    onkeydown={onPanelKey}
  >
    <header class="preview-header">
      <div class="preview-heading">
        <h2 class="preview-title" id="attachment-preview-title">
          {current?.name ?? 'File'}
        </h2>
        <p class="preview-position">{positionLabel}</p>
      </div>
      <div class="preview-nav">
        <button
          type="button"
          class="preview-nav-btn"
          data-testid="attachment-preview-prev"
          aria-label="Previous file"
          disabled={!canPrev}
          onclick={goPrev}
        >
          Previous
        </button>
        <button
          type="button"
          class="preview-nav-btn"
          data-testid="attachment-preview-next"
          aria-label="Next file"
          disabled={!canNext}
          onclick={goNext}
        >
          Next
        </button>
        <button
          type="button"
          class="preview-close"
          data-testid="attachment-preview-close"
          aria-label="Close"
          onclick={onclose}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>

    <div class="preview-body">
      {#if loading}
        <p class="preview-status">Loading preview…</p>
      {:else if view?.kind === 'image'}
        <img
          class="preview-image"
          data-testid="attachment-preview-image"
          src={view.objectUrl}
          alt={current?.name ?? 'Image'}
        />
      {:else if view?.kind === 'pdf'}
        <iframe
          class="preview-pdf"
          data-testid="attachment-preview-pdf"
          title={current?.name ?? 'PDF'}
          src={view.objectUrl}
        ></iframe>
      {:else if view?.kind === 'markdown'}
        <div class="preview-markdown" data-testid="attachment-preview-markdown">
          {@html markdownHtml}
        </div>
      {:else if view?.kind === 'text'}
        <pre class="preview-text" data-testid="attachment-preview-text">{view.text}</pre>
      {:else}
        <div class="preview-fallback" data-testid="attachment-preview-fallback">
          <p class="preview-fallback-name">{current?.name}</p>
          <p class="preview-fallback-meta">
            {#if sizeLabel}{sizeLabel} · {/if}{typeLabel}
          </p>
          {#if view?.kind === 'error'}
            <p class="preview-status" role="status">{view.message}</p>
          {/if}
          {#if current}
            <button
              type="button"
              class="preview-open-files"
              data-testid="attachment-preview-open-in-files"
              onclick={openInFiles}
            >
              Open in Files
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .preview-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40010;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.62);
  }

  .preview-dialog {
    box-sizing: border-box;
    width: min(720px, 100%);
    max-height: min(86vh, 780px);
    display: flex;
    flex-direction: column;
    padding: 16px;
    border: 1px solid var(--line2, var(--pop-border, rgba(255, 255, 255, 0.14)));
    border-radius: 10px;
    background: var(--v4-surface-solid, var(--elevated, var(--pop-bg, #1e1e24)));
    color: var(--t1, var(--pop-text, #e8e8e8));
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  }

  .preview-dialog:focus {
    outline: none;
  }

  .preview-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
    margin-bottom: 12px;
  }

  .preview-heading {
    min-width: 0;
  }

  .preview-title {
    margin: 0;
    overflow: hidden;
    font: 600 14px/1.3 var(--font-ui, inherit);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-position {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--muted-2, var(--pop-muted, #a0a0a0));
  }

  .preview-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .preview-nav-btn,
  .preview-open-files,
  .preview-close {
    appearance: none;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 6px;
    background: color-mix(in srgb, var(--t1, #fff) 10%, transparent);
    color: inherit;
    cursor: pointer;
    font: 500 12px/1.3 var(--font-ui, inherit);
  }

  .preview-nav-btn,
  .preview-open-files {
    padding: 6px 10px;
  }

  .preview-nav-btn:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .preview-close {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
  }

  .preview-nav-btn:hover,
  .preview-open-files:hover,
  .preview-close:hover,
  .preview-nav-btn:focus-visible,
  .preview-open-files:focus-visible,
  .preview-close:focus-visible {
    border-color: var(--t3, currentColor);
    outline: none;
  }

  .preview-body {
    min-height: 180px;
    overflow: auto;
    flex: 1;
  }

  .preview-image {
    display: block;
    max-width: 100%;
    max-height: 60vh;
    margin: 0 auto;
  }

  .preview-pdf {
    width: 100%;
    min-height: 52vh;
    border: 0;
    background: #fff;
  }

  .preview-markdown,
  .preview-text {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .preview-text {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }

  .preview-fallback {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 4px;
  }

  .preview-fallback-name {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .preview-fallback-meta,
  .preview-status {
    margin: 0;
    font-size: 12px;
    color: var(--muted-2, var(--pop-muted, #a0a0a0));
  }
</style>
