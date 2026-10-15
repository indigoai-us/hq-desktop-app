<script lang="ts">
  // Titlebar "Finishing setup" chip (install-flow-rethink US-005). Reads the
  // native background install queue and never blocks anything: it names the
  // item running now and offers Retry when an item needs attention.
  import { untrack } from "svelte";
  import {
    INSTALL_QUEUE_PROGRESS_EVENT,
    finishingSetupLabel,
    finishingSetupVisible,
    parseInstallQueueStatus,
    type InstallQueueHost,
    type InstallQueueStatus,
  } from "./finishing-setup.js";

  interface Props {
    host?: InstallQueueHost | null;
  }

  let { host = null }: Props = $props();

  let status = $state<InstallQueueStatus | null>(null);
  let retrying = $state(false);
  let retryFailed = $state(false);

  $effect(() => {
    const current = host;
    if (!current) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // A progress event can land before the initial read resolves; the event
    // is newer, so the read must not overwrite it.
    let sawEvent = false;

    untrack(() => {
      void current
        .listen(INSTALL_QUEUE_PROGRESS_EVENT, (event) => {
          const parsed = parseInstallQueueStatus(event?.payload);
          if (disposed || !parsed) return;
          sawEvent = true;
          status = parsed;
          if (parsed.state !== "attention") retryFailed = false;
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch((err) => {
          console.error("finishing setup chip: listen failed:", err);
        });

      void current
        .getStatus()
        .then((value) => {
          if (disposed || sawEvent) return;
          status = parseInstallQueueStatus(value);
        })
        .catch((err) => {
          console.error("finishing setup chip: status read failed:", err);
        });
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  });

  function retry(): void {
    const current = host;
    if (!current || retrying) return;
    retrying = true;
    retryFailed = false;
    void current
      .retry()
      .catch((err) => {
        console.error("finishing setup chip: retry failed:", err);
        retryFailed = true;
      })
      .finally(() => {
        retrying = false;
      });
  }

  const visible = $derived(finishingSetupVisible(status));
  const label = $derived(status ? finishingSetupLabel(status) : "");
</script>

{#if visible && status}
  <div
    class="finishing-setup-chip"
    data-testid="finishing-setup-chip"
    data-state={status.state}
    role="status"
    aria-live="polite"
  >
    {#if status.state === "running"}
      <span class="dot" aria-hidden="true"></span>
    {/if}
    <span class="label">{label}</span>
    {#if status.state === "attention"}
      <button
        type="button"
        class="retry"
        data-testid="finishing-setup-retry"
        disabled={retrying}
        aria-busy={retrying}
        onclick={retry}
      >
        {retrying ? "Retrying" : "Retry"}
      </button>
      {#if retryFailed}
        <span class="note" data-testid="finishing-setup-retry-failed">Could not retry. Try again.</span>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .finishing-setup-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--line);
    border-radius: 11px;
    color: var(--t2);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    -webkit-app-region: no-drag;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--t2);
    opacity: 0.7;
    animation: finishing-setup-pulse 1.6s ease-in-out infinite;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 280px;
  }

  .retry {
    height: 18px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    cursor: pointer;
  }

  .retry:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .note {
    opacity: 0.8;
  }

  @keyframes finishing-setup-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 0.9;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
