<script lang="ts">
  /**
   * Shell-owned confirm for "Move to another company" (US-017B).
   * Company picker lives here — not inside ChannelStatusPopover / Atlas rows —
   * because those surfaces close on outside mousedown.
   */
  import type { MigrateCompanyOption } from "../chat/session-migrate.js";

  interface Props {
    open: boolean;
    sessionId: string;
    sourceLabel?: string | null;
    destinations: readonly MigrateCompanyOption[];
    confirmLabel?: string;
    cancelLabel?: string;
    submitting?: boolean;
    error?: string | null;
    onconfirm: (destinationCompanyUid: string) => void;
    oncancel: () => void;
  }

  let {
    open,
    sessionId,
    sourceLabel = null,
    destinations,
    confirmLabel = "Move session",
    cancelLabel = "Cancel",
    submitting = false,
    error = null,
    onconfirm,
    oncancel,
  }: Props = $props();

  let selectedUid = $state("");

  $effect(() => {
    if (!open) return;
    const first = destinations[0]?.uid ?? "";
    if (!selectedUid || !destinations.some((d) => d.uid === selectedUid)) {
      selectedUid = first;
    }
  });

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

  function submit(): void {
    const uid = selectedUid.trim();
    if (!uid || submitting) return;
    onconfirm(uid);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="confirm-backdrop"
    data-testid="migrate-session-dialog"
    role="presentation"
    use:portal
    onclick={(e) => {
      if (e.target === e.currentTarget && !submitting) oncancel();
    }}
  >
    <div
      class="confirm-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="migrate-title"
      aria-describedby="migrate-copy"
    >
      <h2 class="confirm-title" id="migrate-title">Move to another company?</h2>
      <p class="confirm-copy" id="migrate-copy">
        Move session <code class="migrate-sid">{sessionId}</code>
        {#if sourceLabel}
          from {sourceLabel}
        {/if}
        to another company. This freezes the source, copies history, and leaves a
        tombstone. It does not move any project or task.
      </p>
      <label class="migrate-label" for="migrate-dest-company">
        Destination company
      </label>
      <select
        id="migrate-dest-company"
        class="migrate-select"
        data-testid="migrate-dest-select"
        bind:value={selectedUid}
        disabled={submitting || destinations.length === 0}
      >
        {#each destinations as dest (dest.uid)}
          <option value={dest.uid}>{dest.label}</option>
        {/each}
      </select>
      {#if error}
        <p class="migrate-error" data-testid="migrate-session-error" role="alert">
          {error}
        </p>
      {/if}
      <div class="confirm-actions">
        <button
          type="button"
          class="confirm-btn ghost"
          disabled={submitting}
          onclick={oncancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          class="confirm-btn"
          data-testid="migrate-session-confirm"
          disabled={submitting || !selectedUid}
          onclick={submit}
        >
          {#if submitting}…{:else}{confirmLabel}{/if}
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
    width: min(400px, 100%);
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

  .migrate-sid {
    font: 500 12px/1.3 var(--font-mono, ui-monospace, monospace);
    word-break: break-all;
  }

  .migrate-label {
    display: block;
    margin: 14px 0 6px;
    color: var(--t2, var(--t3));
    font: 500 12px/1.3 var(--font-ui);
  }

  .migrate-select {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: var(--v4-radius-button, 6px);
    background: color-mix(in srgb, var(--t1) 6%, transparent);
    color: var(--t1);
    font: 400 13px/1.3 var(--font-ui);
  }

  .migrate-error {
    margin: 10px 0 0;
    color: var(--warn-ink, #f3b4ae);
    font: 400 12px/1.4 var(--font-ui);
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

  .confirm-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .confirm-btn:hover:not(:disabled),
  .confirm-btn:focus-visible:not(:disabled) {
    border-color: var(--t3);
    outline: none;
  }
</style>
