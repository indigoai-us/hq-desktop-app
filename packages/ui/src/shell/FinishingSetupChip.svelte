<script lang="ts">
  // Titlebar "Finishing setup" chip (install-flow-rethink US-005). Reads the
  // native background install queue and never blocks anything: it names the
  // item running now. A failed item is the host's to report (the assistant
  // says what and the fix); the chip shows no count and no Retry.
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
    /** Items failed: the host tells the assistant (the chip shows no count). */
    onattention?: ((failed: readonly string[]) => void) | null;
  }

  let { host = null, onattention = null }: Props = $props();
  let toldAbout = "";
  function noteAttention(parsed: InstallQueueStatus | null): void {
    if (!parsed) return;
    if (parsed.state !== "attention") {
      // The failure the host was told about is over (the queue resumed and
      // the item went through): say so, so a held notice is dropped.
      if (toldAbout) {
        toldAbout = "";
        onattention?.([]);
      }
      return;
    }
    const key = [...parsed.failed].sort().join(",");
    if (!key || key === toldAbout) return;
    toldAbout = key;
    onattention?.(parsed.failed);
  }

  let status = $state<InstallQueueStatus | null>(null);

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
          noteAttention(parsed);
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
          noteAttention(status);
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
