<script lang="ts">
  /**
   * The one shared toast layer (OWNER-003). Mounted once at the app root and
   * portaled to <body>, fixed to the window's lower right above
   * sheets, popovers and dialogs. Newest on top, at most three visible; the
   * rest collapse into a "+N more" row. Escape is never handled here, so the
   * nested Escape layer keeps working. Solid surface (no backdrop-filter:
   * WKWebView paints it as a square behind rounded cards).
   */
  import { onDestroy } from "svelte";
  import {
    MAX_VISIBLE_TOASTS,
    claimToastLayer,
    ownsToastLayer,
    releaseToastLayer,
    dismissToast,
    pauseToast,
    resumeToast,
    toastItems,
    type ToastItem,
  } from "./toast-stack.svelte.js";

  const token = Symbol("toast-layer");
  claimToastLayer(token);
  onDestroy(() => releaseToastLayer(token));
  const owner = $derived(ownsToastLayer(token));

  /** Portal to <body> so no transformed or clipped ancestor traps the layer. */
  function toBody(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const newestFirst = $derived([...toastItems()].reverse());
  const visible = $derived(newestFirst.slice(0, MAX_VISIBLE_TOASTS));
  const hidden = $derived(Math.max(0, newestFirst.length - MAX_VISIBLE_TOASTS));

  function reducedMotion(): boolean {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  // Enter is a CSS fade + slide (no Web Animations, which some hosts lack);
  // reduced motion drops it.
  const reduced = reducedMotion();

  function close(toast: ToastItem): void {
    toast.onDismiss?.();
    dismissToast(toast.id);
  }
</script>

{#if owner}
<div
  class="ts-stack"
  use:toBody
  aria-live="polite"
  data-testid="toast-stack"
  data-reduced-motion={reduced ? "true" : "false"}
  class:reduced
>
  {#each visible as toast (toast.id)}
    <div
      class="ts-toast"
      class:err={toast.tone === "err"}
      role={toast.tone === "err" ? "alert" : "status"}
      data-testid={toast.testId ?? "toast"}
      data-toast-key={toast.key}
      data-kind={toast.kind}
      data-tone={toast.tone}
      onmouseenter={() => pauseToast(toast.id)}
      onmouseleave={() => resumeToast(toast.id)}
    >
      <div class="ts-b">
        <span class="ts-title">{toast.title}</span>
        {#if toast.detail}<span class="ts-m" data-testid="toast-detail">{toast.detail}</span>{/if}
        {#if toast.progress != null}
          {@const fraction = typeof toast.progress === "number" ? Math.min(1, Math.max(0, toast.progress)) : null}
          <div
            class="ts-bar"
            class:indeterminate={fraction === null}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
            data-testid="toast-progress"
          >
            <span style:transform={fraction === null ? undefined : `scaleX(${fraction})`}></span>
          </div>
        {/if}
        {#if toast.error}<span class="ts-e" role="alert" data-testid="toast-error">{toast.error}</span>{/if}
        {#if toast.actions?.length || (toast.actionLabel && toast.onAction)}
          <div class="ts-acts">
            {#each toast.actions ?? [] as action (action.testId ?? action.label)}
              <button
                type="button"
                class="ts-act"
                class:primary={action.primary}
                data-testid={action.testId}
                aria-label={action.ariaLabel}
                title={action.title}
                disabled={action.disabled}
                onclick={() => {
                  action.onAction();
                  if (!action.keepOpen) dismissToast(toast.id);
                }}>{action.label}</button
              >
            {/each}
            {#if toast.actionLabel && toast.onAction}
              <button
                type="button"
                class="ts-act"
                data-testid="toast-action"
                onclick={() => {
                  toast.onAction?.();
                  dismissToast(toast.id);
                }}>{toast.actionLabel}</button
              >
            {/if}
          </div>
        {/if}
      </div>
      <button
        type="button"
        class="ts-x"
        aria-label={toast.dismissLabel ?? "Dismiss"}
        data-testid="toast-dismiss"
        onclick={() => close(toast)}
      >
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  {/each}
  {#if hidden > 0}
    <div class="ts-more" data-testid="toast-overflow">+{hidden} more</div>
  {/if}
</div>
{/if}

<style>
  /* QA-095: the layer is portaled to <body>, outside .chat-shell where
     --font-ui is defined, so it carries its own sans fallback. Without it
     the font shorthand is invalid and the toast drops to the serif default. */
  .ts-stack {
    --ts-font: var(--font-ui, "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-family: var(--ts-font);
    position: fixed;
    right: 16px;
    bottom: var(--toast-bottom-inset, 84px);
    z-index: 50000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 360px;
    max-width: calc(100vw - 32px);
    pointer-events: none;
  }

  .ts-toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 24px;
    gap: 8px;
    align-items: start;
    padding: 10px 8px 10px 14px;
    /* OWNER-017: the overlay token set the Library popout and every other
       overlay paint (OWNER-006); --v4-surface-solid read blue-grey. */
    background: var(--overlay-bg);
    border: 1px solid var(--overlay-border);
    border-radius: 10px;
    box-shadow: var(--overlay-shadow);
    color: var(--v4-text-1);
    font: 400 13px/1.45 var(--ts-font);
  }

  .ts-toast {
    animation: ts-in 160ms ease-out both;
  }

  .reduced .ts-toast {
    animation: none;
  }

  @keyframes ts-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ts-toast {
      animation: none;
    }
  }

  .ts-b {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .ts-title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ts-m {
    color: var(--v4-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ts-bar {
    position: relative;
    height: 3px;
    margin-top: 6px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--v4-hairline, rgba(255, 255, 255, 0.12));
  }

  .ts-bar span {
    position: absolute;
    inset: 0;
    border-radius: 2px;
    background: var(--v4-text-2);
    transform-origin: left center;
    transition: transform 200ms linear;
  }

  .ts-bar.indeterminate span {
    width: 30%;
    animation: ts-shimmer 1.2s ease-in-out infinite;
  }

  @keyframes ts-shimmer {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }

  /* Reduced motion: a still, half-filled bar stands in for the shimmer. */
  .reduced .ts-bar.indeterminate span {
    width: 50%;
    animation: none;
  }

  .reduced .ts-bar span {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .ts-bar.indeterminate span {
      width: 50%;
      animation: none;
    }

    .ts-bar span {
      transition: none;
    }
  }

  .ts-e,
  .err .ts-title {
    color: var(--v4-error, #f0616d);
  }

  .ts-acts {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  /* OWNER-007 labelled button, compact size: secondary is a 1px line on the
     button fill, primary is a text-colour fill with overlay-surface ink. The
     layer is portaled outside .chat-shell, so each token has a v4 fallback. */
  .ts-act {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--line2, var(--v4-control-border));
    border-radius: 8px;
    background: var(--btn-bg, transparent);
    color: var(--t1, var(--v4-text-1));
    font: 500 12px/16px var(--ts-font);
    cursor: default;
  }

  .ts-act.primary {
    border-color: transparent;
    background: var(--t1, var(--v4-text-1));
    color: var(--overlay-bg);
  }

  .ts-act.primary:not(:disabled):hover {
    opacity: 0.88;
  }

  .ts-act:disabled {
    opacity: 0.5;
  }

  .ts-x {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-3);
    cursor: default;
  }

  .ts-act:not(.primary):not(:disabled):hover,
  .ts-x:hover {
    background: var(--overlay-hover);
  }

  .ts-more {
    pointer-events: auto;
    align-self: flex-end;
    padding: 2px 8px;
    color: var(--v4-text-2);
    font: 400 13px/1.45 var(--ts-font);
  }
</style>
