<script lang="ts" generics="T">
  // Fold line for a run of hidden messages (hq-message-visibility US-005).
  // Hairline rules either side of a pill with up to three stacked sender
  // avatars and a count. Clicking the pill opens the run inline, indented
  // with a left rule in the agent tile colour; clicking again closes it.
  // Open state is local: it resets when the fold unmounts (the host keys
  // folds by conversation, so leaving a conversation closes every fold).
  import type { Snippet } from "svelte";
  import IdentityMark from "./messaging/IdentityMark.svelte";
  import { foldLabel, type FoldRun } from "./message-folds.js";

  interface Props {
    run: FoldRun<T>;
    /** Renders one hidden message inside the open fold. */
    item: Snippet<[T, number]>;
  }

  let { run, item }: Props = $props();

  let open = $state(false);
  const label = $derived(foldLabel(run, open));
  const bodyId = $derived(`message-fold-body-${run.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`);

  function isAgentUid(uid: string): boolean {
    return uid.startsWith("agt_");
  }
</script>

<div
  class="message-fold"
  class:open
  data-testid="message-fold"
  data-fold-count={run.items.length}
>
  <div class="message-fold-line">
    <button
      type="button"
      class="message-fold-pill"
      data-testid="message-fold-toggle"
      aria-expanded={open}
      aria-controls={bodyId}
      onclick={() => (open = !open)}
    >
      {#if run.senders.length > 0}
        <span class="message-fold-stack" aria-hidden="true">
          {#each run.senders as sender (sender.uid || sender.name)}
            <span class="message-fold-avatar">
              <IdentityMark
                kind={isAgentUid(sender.uid) ? "agent" : "person"}
                label={sender.name}
                agentUid={sender.uid}
                size="small"
              />
            </span>
          {/each}
        </span>
      {/if}
      <span class="message-fold-label" data-testid="message-fold-label">{label}</span>
    </button>
  </div>
  {#if open}
    <div class="message-fold-body" id={bodyId} data-testid="message-fold-body">
      {#each run.items as hidden, index (index)}
        {@render item(hidden, index)}
      {/each}
    </div>
  {/if}
</div>

<style>
  .message-fold {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .message-fold-line {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--t3, rgba(255, 255, 255, 0.32));
    font-size: 12px;
  }

  .message-fold-line::before,
  .message-fold-line::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line, rgba(255, 255, 255, 0.07));
  }

  .message-fold-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.11));
    background: var(--raised, rgba(255, 255, 255, 0.05));
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .message-fold-pill:hover {
    background: var(--hover, rgba(255, 255, 255, 0.05));
  }

  .message-fold-pill:focus-visible {
    outline: 2px solid var(--border-active, rgba(255, 255, 255, 0.3));
    outline-offset: 2px;
  }

  .open .message-fold-pill {
    color: var(--t1, rgba(255, 255, 255, 0.95));
    border-color: var(--panel-border, rgba(255, 255, 255, 0.1));
  }

  .message-fold-stack {
    display: inline-flex;
  }

  .message-fold-avatar {
    display: inline-flex;
    margin-left: -4px;
  }

  .message-fold-avatar:first-child {
    margin-left: 0;
  }

  .message-fold-body {
    border-left: 2px solid var(--ice-tile, #2c3d52);
    margin-left: 11px;
    padding-left: 19px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    opacity: 0.9;
  }
</style>
