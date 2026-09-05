<!--
  Customer-visible repair notice (client-sync-health-control-plane US-010).

  The desktop repair dispatcher (Rust `commands/client_repair.rs`) emits the
  closed `client-repair:notice` event for the two disruptive, consequence-gated
  repair kinds — RESUME_SYNC and RESTART_APP — so the customer always SEES a
  support-initiated repair happen (AC #2). RESUME_SYNC additionally records that
  support changed an intentional local setting (Cloud-off pause). RESTART_APP
  carries a visible countdown before the app restarts automatically (decision
  ledger #4).

  All copy is fixed client-side; the event payload only ever carries closed
  fields (kind, title, message, countdownSeconds, changedLocalSetting) — no
  server-provided text is rendered.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

  interface RepairNoticePayload {
    kind: string;
    title: string;
    message: string;
    countdownSeconds: number;
    changedLocalSetting: boolean;
  }

  let notice = $state<RepairNoticePayload | null>(null);
  let remaining = $state(0);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  function clearCountdown() {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function show(payload: RepairNoticePayload) {
    clearCountdown();
    notice = payload;
    remaining = Math.max(0, Math.floor(payload.countdownSeconds ?? 0));
    if (remaining > 0) {
      countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearCountdown();
          // The Rust side performs the actual restart after flushing its
          // receipt; the UI just counts down to it and then reflects "now".
        }
      }, 1000);
    }
  }

  function dismiss() {
    clearCountdown();
    notice = null;
  }

  // Register the listener synchronously before any await so a notice emitted
  // during setup is not missed (same discipline as the sibling popouts).
  let unlisten: UnlistenFn | undefined;
  listen<RepairNoticePayload>('client-repair:notice', (event) => {
    show(event.payload);
  }).then((fn) => {
    unlisten = fn;
  });

  onDestroy(() => {
    clearCountdown();
    unlisten?.();
  });
</script>

{#if notice}
  <div class="repair-notice" role="status" aria-live="polite" data-testid="repair-notice">
    <div class="repair-notice-body">
      <span class="repair-notice-dot" aria-hidden="true"></span>
      <div class="repair-notice-text">
        <strong class="repair-notice-title">{notice.title}</strong>
        <span class="repair-notice-message">{notice.message}</span>
        {#if notice.changedLocalSetting}
          <span class="repair-notice-meta">Support changed a setting you had turned off.</span>
        {/if}
        {#if remaining > 0}
          <span class="repair-notice-meta" data-testid="repair-notice-countdown">
            Restarting in {remaining}s…
          </span>
        {/if}
      </div>
      <button class="repair-notice-dismiss" type="button" aria-label="Dismiss" onclick={dismiss}>×</button>
    </div>
  </div>
{/if}

<style>
  .repair-notice {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    max-width: 460px;
  }
  .repair-notice-body {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--surface-raised, #1c1c1f);
    color: var(--text-primary, #f4f4f5);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  }
  .repair-notice-dot {
    margin-top: 5px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent, #6ea8fe);
    flex: 0 0 auto;
  }
  .repair-notice-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .repair-notice-title {
    font-size: 13px;
    font-weight: 600;
  }
  .repair-notice-message {
    font-size: 12px;
    opacity: 0.85;
  }
  .repair-notice-meta {
    font-size: 11px;
    opacity: 0.7;
  }
  .repair-notice-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
  }
  .repair-notice-dismiss:hover {
    opacity: 1;
  }
</style>
