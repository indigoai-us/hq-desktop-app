<script lang="ts">
  /**
   * Test-only stand-in for the content of a card's modal.
   *
   * It does exactly what the registry promises real content: it is handed a
   * frame and the bot it was opened for, and it draws a CardModal with a
   * body and a footer of its own. `DesktopApp.cloud-bot-card-modal.test.ts`
   * registers it through the registry's test seam.
   */
  import { onDestroy } from "svelte";
  import CardModal from "../chat/messaging/CardModal.svelte";
  import type { CardModalContentProps } from "../chat/messaging/card-modal-registry.js";

  let { frame, agentUid, target, botName, companyUid, openUrl, refresh }: CardModalContentProps = $props();

  let busy = $state(false);

  // Real content may read what it was handed while it is being taken down
  // (to cancel a wait, say). The shell must still have it then.
  onDestroy(() => {
    document.body.dataset.cardModalProbeLast = `${frame.title}:${botName}:${agentUid}`;
  });
</script>

<CardModal {...frame} {busy} steps={{ labels: ["Start", "Finish"], current: 0 }}>
  {#snippet body()}
    <p
      data-testid="card-modal-probe"
      data-agent-uid={agentUid}
      data-target={target}
      data-bot-name={botName}
      data-company-uid={companyUid ?? ""}
    >
      Probe for {botName}
    </p>
    <button type="button" data-testid="card-modal-probe-link" onclick={() => openUrl("https://example.com/slack")}>
      Open a page
    </button>
    <button type="button" data-testid="card-modal-probe-refresh" onclick={() => void refresh()}>Check again</button>
    <button type="button" data-testid="card-modal-probe-busy" onclick={() => (busy = !busy)}>Toggle busy</button>
  {/snippet}
  {#snippet footer()}
    <button type="button" class="card-modal-btn is-primary" data-testid="card-modal-probe-done" onclick={frame.onclose}>
      Done
    </button>
  {/snippet}
</CardModal>
