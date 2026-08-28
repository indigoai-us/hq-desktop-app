<script lang="ts">
  /**
   * In-app confirm. window.confirm is a silent no-op in the Tauri WKWebView.
   * The card is fully opaque — glass --raised lets the page bleed through.
   */
  interface Props {
    open: boolean;
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    open,
    title = "Confirm",
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onconfirm,
    oncancel,
  }: Props = $props();

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }

  function portal(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    const host =
      document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
    host.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="confirm-backdrop"
    data-testid="confirm-dialog"
    role="presentation"
    use:portal
    onclick={(e) => {
      if (e.target === e.currentTarget) oncancel();
    }}
  >
    <div
      class="confirm-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-copy"
    >
      <h2 class="confirm-title" id="confirm-title">{title}</h2>
      <p class="confirm-copy" id="confirm-copy">{message}</p>
      <div class="confirm-actions">
        <button type="button" class="confirm-btn ghost" onclick={oncancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          class="confirm-btn"
          class:danger
          data-testid="confirm-dialog-ok"
          onclick={onconfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.62);
  }

  .confirm-card {
    width: min(360px, 100%);
    padding: 18px 18px 14px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 10px;
    background: var(--v4-surface-solid, var(--elevated, #1e1e24));
    color: var(--t1);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  }

  .confirm-title {
    margin: 0;
    font: 600 14px/1.3 var(--font-ui);
  }

  .confirm-copy {
    margin: 8px 0 0;
    color: var(--t2, var(--t3));
    font: 400 13px/1.45 var(--font-ui);
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .confirm-btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: var(--v4-radius-button, 6px);
    background: color-mix(in srgb, var(--t1) 10%, transparent);
    color: var(--t1);
    font: 500 12px/1.3 var(--font-ui);
    cursor: pointer;
  }

  .confirm-btn.ghost {
    background: transparent;
    color: var(--t2);
  }

  .confirm-btn.danger {
    color: var(--warn-ink, #f3b4ae);
    border-color: color-mix(in srgb, var(--warn-ink, #d9584a) 40%, transparent);
  }

  .confirm-btn:hover,
  .confirm-btn:focus-visible {
    border-color: var(--t3);
    outline: none;
  }
</style>
