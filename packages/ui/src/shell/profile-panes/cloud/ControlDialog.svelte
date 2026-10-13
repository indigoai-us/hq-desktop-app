<script lang="ts">
  /**
   * The cloud bot pane's pop-up: editing instructions, a brain file, a
   * routine, a channel. Drawn over the whole window on the overlay tokens,
   * like ConfirmDialog. Esc and a click outside close it only when nothing is
   * unsaved; otherwise they ask before throwing the edits away.
   */
  import type { Snippet } from "svelte";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import ConfirmDialog from "../../../common/ConfirmDialog.svelte";

  interface Props {
    title: string;
    subtitle?: string | null;
    dirty?: boolean;
    busy?: boolean;
    wide?: boolean;
    testid?: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { title, subtitle = null, dirty = false, busy = false, wide = false, testid = "control-dialog", onclose, children, footer }: Props = $props();

  let confirming = $state(false);
  let card = $state<HTMLElement | null>(null);
  const titleId = `control-dialog-title-${Math.random().toString(36).slice(2, 8)}`;

  function requestClose(): void {
    if (busy) return;
    if (dirty) {
      confirming = true;
      return;
    }
    onclose();
  }

  function onKey(e: KeyboardEvent): void {
    if (confirming) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    }
  }

  function portal(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    const host = document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
    host.appendChild(node);
    return { destroy: () => node.remove() };
  }

  $effect(() => {
    if (!card) return;
    const before = document.activeElement as HTMLElement | null;
    const first = card.querySelector<HTMLElement>("[data-autofocus]") ?? card.querySelector<HTMLElement>("input, textarea, button");
    first?.focus();
    return () => before?.focus?.();
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="cd-backdrop"
  role="presentation"
  use:portal
  onclick={(e) => {
    if (e.target === e.currentTarget) requestClose();
  }}
>
  <div
    class="cd-card"
    class:wide
    bind:this={card}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    data-testid={testid}
    data-dirty={dirty ? "true" : "false"}
  >
    <header class="cd-head">
      <div class="cd-titles">
        <h2 class="cd-title" id={titleId}>{title}</h2>
        {#if subtitle}<p class="cd-sub">{subtitle}</p>{/if}
      </div>
      <button type="button" class="cd-x" aria-label="Close" data-testid="{testid}-close" disabled={busy} onclick={requestClose}><RailIcon name="x" /></button>
    </header>
    <div class="cd-body">{@render children()}</div>
    {#if footer}<footer class="cd-foot">{@render footer()}</footer>{/if}
  </div>
</div>

<ConfirmDialog
  open={confirming}
  title="Discard changes?"
  message="Your edits have not been saved."
  confirmLabel="Discard"
  cancelLabel="Keep editing"
  danger
  onconfirm={() => {
    confirming = false;
    onclose();
  }}
  oncancel={() => (confirming = false)}
/>

<style>
  .cd-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.45);
  }
  .cd-card {
    width: min(480px, 100%);
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--overlay-border);
    border-radius: 10px;
    background: var(--overlay-bg);
    box-shadow: var(--overlay-shadow);
    color: var(--v4-text-1);
    font: 400 13px/1.45 var(--font-ui, var(--font-sans));
    overflow: hidden;
  }
  .cd-card.wide { width: min(680px, 100%); }
  .cd-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 16px 16px 8px;
  }
  .cd-titles { min-width: 0; flex: 1; }
  .cd-title { margin: 0; font-size: 13px; font-weight: 500; color: var(--v4-text-1); }
  .cd-sub {
    margin: 2px 0 0;
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cd-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }
  .cd-x:hover:not(:disabled) { background: var(--overlay-hover); color: var(--v4-text-1); }
  .cd-body {
    min-height: 0;
    overflow: auto;
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .cd-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--overlay-border);
  }
</style>
