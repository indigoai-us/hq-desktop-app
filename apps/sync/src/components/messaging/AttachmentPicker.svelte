<script lang="ts">
  /**
   * In-app grid of every file on a share card. Opened from AttachmentStack.
   * Escape / close button dismiss; Tab is trapped while open.
   */
  import {
    attachmentTypeBadge,
    formatAttachmentSize,
    type MessageAttachment,
  } from '../../lib/messageAttachments';

  interface Props {
    attachments: MessageAttachment[];
    onclose: () => void;
    onselect: (index: number) => void;
  }

  let { attachments, onclose, onselect }: Props = $props();

  const FOCUSABLE =
    'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

  let panelEl = $state<HTMLDivElement | null>(null);

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

  function onPanelKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
      return;
    }
    trapTab(event);
  }

  function onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onclose();
  }

  $effect(() => {
    const panel = panelEl;
    if (!panel) return;
    panel.focus();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="picker-backdrop"
  data-testid="attachment-picker"
  role="presentation"
  use:portal
  onclick={onBackdropClick}
>
  <div
    class="picker-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="attachment-picker-title"
    tabindex="-1"
    bind:this={panelEl}
    onkeydown={onPanelKey}
  >
    <header class="picker-header">
      <h2 class="picker-title" id="attachment-picker-title">Shared files</h2>
      <button
        type="button"
        class="picker-close"
        data-testid="attachment-picker-close"
        aria-label="Close"
        onclick={onclose}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </header>
    <ul class="picker-grid">
      {#each attachments as item, index (item.id || item.vaultPath)}
        {@const size = formatAttachmentSize(item.sizeBytes)}
        <li>
          <button
            type="button"
            class="picker-item"
            data-testid="attachment-picker-item"
            aria-label={item.name}
            onclick={() => onselect(index)}
          >
            <span class="picker-badge" aria-hidden="true">{attachmentTypeBadge(item)}</span>
            <span class="picker-name">{item.name}</span>
            <span class="picker-meta">
              {#if size}{size} · {/if}{attachmentTypeBadge(item)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.62);
  }

  .picker-dialog {
    box-sizing: border-box;
    width: min(520px, 100%);
    max-height: min(80vh, 640px);
    display: flex;
    flex-direction: column;
    padding: 16px 16px 14px;
    border: 1px solid var(--line2, var(--pop-border, rgba(255, 255, 255, 0.14)));
    border-radius: 10px;
    background: var(--v4-surface-solid, var(--elevated, var(--pop-bg, #1e1e24)));
    color: var(--t1, var(--pop-text, #e8e8e8));
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  }

  .picker-dialog:focus {
    outline: none;
  }

  .picker-dialog:focus-visible {
    outline: 2px solid var(--vio-ink, currentColor);
    outline-offset: 2px;
  }

  .picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    margin-bottom: 12px;
  }

  .picker-title {
    margin: 0;
    font: 600 14px/1.3 var(--font-ui, inherit);
  }

  .picker-close {
    appearance: none;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .picker-close:hover,
  .picker-close:focus-visible {
    border-color: var(--t3, currentColor);
    outline: none;
  }

  .picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow: auto;
    min-height: 0;
  }

  .picker-item {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    min-height: 96px;
    padding: 10px;
    border: 1px solid var(--border, var(--pop-border, rgba(255, 255, 255, 0.14)));
    border-radius: 10px;
    background: var(--surface-raise, var(--elevated, #1e1e24));
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .picker-item:hover {
    border-color: var(--border-strong, rgba(255, 255, 255, 0.22));
  }

  .picker-item:focus-visible {
    outline: 2px solid var(--vio-ink, currentColor);
    outline-offset: 2px;
  }

  .picker-badge {
    padding: 1px 5px;
    border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.18));
    border-radius: 3px;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted-2, var(--pop-muted, #a0a0a0));
  }

  .picker-name {
    max-width: 100%;
    overflow: hidden;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-meta {
    font-size: 11px;
    color: var(--muted-2, var(--pop-muted, #a0a0a0));
  }
</style>
