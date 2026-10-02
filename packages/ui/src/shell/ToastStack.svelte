<script lang="ts">
  /**
   * Toast stack, bottom-right of the content column. 360 px, popover surface.
   */
  import { dismissToast, toastItems } from "./toast-stack.svelte.js";

  const items = $derived(toastItems());
</script>

{#if items.length > 0}
  <div class="ts-stack" aria-live="polite" data-testid="toast-stack">
    {#each items as toast (toast.id)}
      <div
        class="ts-toast"
        class:ok={toast.tone === "ok"}
        class:err={toast.tone === "err"}
        role={toast.tone === "err" ? "alert" : "status"}
        data-testid="toast"
        data-tone={toast.tone}
      >
        <span class="ts-mk" aria-hidden="true">{toast.tone === "ok" ? "✓" : ""}</span>
        <div class="ts-b">
          <b>{toast.title}</b>
          {#if toast.detail}<span class="ts-m">{toast.detail}</span>{/if}
        </div>
        <button
          type="button"
          class="ts-x"
          aria-label="Dismiss"
          onclick={() => dismissToast(toast.id)}
        >✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .ts-stack {
    position: absolute;
    right: 20px;
    bottom: 20px;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 360px;
    max-width: calc(100% - 40px);
    pointer-events: none;
  }

  .ts-toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px 8px 10px 12px;
    background: var(--v4-popover);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
    font: 13px/1.3 var(--font-ui);
  }

  .ts-mk {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 9px;
    background: transparent;
    border: 1px solid var(--v4-control-border);
    color: var(--v4-text-1);
  }

  .ok .ts-mk {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    border-color: transparent;
  }

  .err .ts-mk {
    background: var(--v4-error);
    border-color: transparent;
  }

  .err .ts-b b {
    color: var(--v4-error);
  }

  .ts-b {
    min-width: 0;
  }

  .ts-b b {
    display: block;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ts-m {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    color: var(--v4-text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ts-x {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-3);
    font-size: 11px;
    cursor: default;
  }

  .ts-x:hover {
    background: var(--v4-hover, var(--v4-active-row));
  }
</style>
