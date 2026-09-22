<script lang="ts">
  /**
   * Session-expired / sign-in-required notice for the desktop window (PL-03).
   *
   * Desktop-window counterpart of the menubar popover's "Keep sync moving"
   * auth-error notice. The popover's version was copy only — the user had to
   * find the sign-in surface themselves — so this one carries the action.
   *
   * Sync deliberately returns Ok on the needs-reauth path and emits
   * `sync:auth-error` instead, which means a paused session is otherwise
   * invisible in this window.
   */
  interface Props {
    /** Runner-supplied reason; falls back to the popover's copy. */
    message?: string | null;
    signingIn?: boolean;
    /** Absent → the banner explains the state without offering an action. */
    onsignin?: () => void | Promise<void>;
    ondismiss?: () => void;
  }

  let { message = null, signingIn = false, onsignin, ondismiss }: Props =
    $props();

  const body = $derived(
    message?.trim() ||
      "Sign in once and HQ will resume syncing automatically.",
  );
</script>

<div
  class="auth-banner"
  role="alert"
  aria-live="assertive"
  data-testid="session-expired-banner"
>
  <div class="auth-copy">
    <strong>Sign in required</strong>
    <span data-testid="session-expired-message">{body}</span>
  </div>
  <div class="auth-actions">
    {#if onsignin}
      <button
        type="button"
        class="auth-signin"
        data-testid="session-expired-signin"
        disabled={signingIn}
        aria-busy={signingIn}
        onclick={() => void onsignin?.()}
      >
        {signingIn ? "Opening sign-in…" : "Sign in"}
      </button>
    {/if}
    {#if ondismiss}
      <button
        type="button"
        class="auth-dismiss"
        data-testid="session-expired-dismiss"
        onclick={() => ondismiss?.()}
      >
        Dismiss
      </button>
    {/if}
  </div>
</div>

<style>
  .auth-banner {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.08));
    background: color-mix(in srgb, var(--v4-text-1, #111) 6%, transparent);
    color: var(--v4-text-1, var(--t1));
    font: 400 13px/1.4 var(--font-ui, system-ui);
  }

  .auth-copy {
    display: flex;
    flex: 1 1 220px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .auth-copy strong {
    font-weight: 600;
  }

  .auth-copy span {
    color: var(--v4-text-2, var(--t2, rgba(0, 0, 0, 0.62)));
  }

  .auth-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .auth-signin,
  .auth-dismiss {
    margin: 0;
    border-radius: 6px;
    font: 500 12px/1 var(--font-ui, system-ui);
    cursor: pointer;
  }

  .auth-signin {
    padding: 7px 12px;
    border: 0;
    background: var(--v4-text-1, #111);
    color: var(--v4-ground, #fff);
  }

  .auth-signin:disabled {
    opacity: 0.55;
    cursor: wait;
  }

  .auth-dismiss {
    padding: 7px 10px;
    border: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.12));
    background: transparent;
    color: var(--v4-text-2, inherit);
  }
</style>
