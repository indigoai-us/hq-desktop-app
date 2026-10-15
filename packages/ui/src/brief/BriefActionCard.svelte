<script lang="ts">
  /**
   * One suggested piece of work as a card: what it is, why now, the evidence,
   * and one button per place it can be done. A tool that is not installed has
   * no button; with no assistant there is no assistant button.
   */
  import { assistantIdempotencyKey, type BriefActionCardData, type BriefActionDestinations } from "./brief-action-cards.js";

  interface Props {
    card: BriefActionCardData;
    destinations: BriefActionDestinations;
    runId?: string | null;
    /** The brief's time, for the idempotency key of a brief with no run id. */
    now: string;
    /** Sends the prompt to the assistant's DM; resolves to the note to show (sent or failed). */
    onassistant: (prompt: string, idempotencyKey: string) => Promise<string | null>;
    /** Opens the tool in the HQ folder with the prompt; resolves to an error message or null. */
    onlaunch: (engine: "claude" | "codex", prompt: string) => Promise<string | null>;
  }
  let { card, destinations, runId = null, now, onassistant, onlaunch }: Props = $props();
  let note = $state<string | null>(null);
  let busy = $state(false);

  async function run(go: () => Promise<string | null>, failed: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      note = await go();
    } catch (err) {
      console.warn("[daily-brief] action failed", err);
      note = failed;
    } finally {
      busy = false;
    }
  }
</script>

<article class="action-card" data-testid="brief-action-card">
  <h3>{card.title}</h3>
  <p class="why" data-testid="brief-action-why">{card.why}</p>
  {#if card.evidence.length}
    <ul class="evidence" data-testid="brief-action-evidence">
      {#each card.evidence as line, i (i)}<li>{line}</li>{/each}
    </ul>
  {/if}
  <div class="dest">
    {#if destinations.assistantName}
      <button
        type="button"
        data-testid="brief-action-assistant"
        disabled={busy}
        onclick={() =>
          void run(
            () => onassistant(card.prompt, assistantIdempotencyKey(runId, card.id, now)),
            `Could not send this to ${destinations.assistantName}. Try again in a moment.`,
          )}
      >Do it with {destinations.assistantName}</button>
    {/if}
    {#if destinations.claudeCode}
      <button type="button" data-testid="brief-action-claude" disabled={busy} onclick={() => void run(() => onlaunch("claude", card.prompt), "Could not open Claude Code. Try again in a moment.")}>Open in Claude Code</button>
    {/if}
    {#if destinations.codex}
      <button type="button" data-testid="brief-action-codex" disabled={busy} onclick={() => void run(() => onlaunch("codex", card.prompt), "Could not open Codex. Try again in a moment.")}>Open in Codex</button>
    {/if}
  </div>
  {#if note}<p class="note" role="status">{note}</p>{/if}
</article>

<style>
  .action-card {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 14px 16px;
    background: rgba(255, 255, 255, 0.03);
  }
  h3 {
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 600;
  }
  .why {
    margin: 0 0 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.72);
  }
  .evidence {
    margin: 0 0 10px;
    padding-left: 16px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.56);
  }
  .dest {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    font: inherit;
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    cursor: pointer;
    transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
  }
  button:active {
    opacity: 0.7;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .note {
    margin: 8px 0 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.56);
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
