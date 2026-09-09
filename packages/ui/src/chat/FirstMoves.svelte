<script lang="ts">
  /**
   * FirstMoves — the short, self-ticking "do one thing" list under the
   * #welcome hero. Pure presentation: the shell computes `moves` (see
   * `firstMovesFor`) and performs the actions; this component only renders
   * one expanded move with one button and reports clicks.
   */
  import {
    FIRST_MOVES_COPY,
    FIRST_MOVES_TITLE,
    type FirstMove,
    type FirstMoveId,
  } from "./first-moves";

  interface Props {
    moves: readonly FirstMove[];
    /** Perform the move's primary action. Resolve with a failure reason to show inline. */
    onmove: (id: FirstMoveId) => Promise<string | null | void> | string | null | void;
    /** The coding-tools move has a second button (Codex). */
    oncodex?: () => Promise<string | null | void> | string | null | void;
  }

  let { moves, onmove, oncodex }: Props = $props();

  let busy = $state<FirstMoveId | "codex" | null>(null);
  let errors = $state<Partial<Record<FirstMoveId, string>>>({});

  async function run(id: FirstMoveId, action: () => Promise<string | null | void> | string | null | void, key: FirstMoveId | "codex" = id): Promise<void> {
    if (busy) return;
    busy = key;
    errors = { ...errors, [id]: undefined };
    try {
      const reason = await action();
      if (typeof reason === "string" && reason.trim()) errors = { ...errors, [id]: reason };
    } catch (err) {
      errors = { ...errors, [id]: err instanceof Error ? err.message : String(err) };
    } finally {
      busy = null;
    }
  }

  const doneCount = $derived(moves.filter((move) => move.state === "done").length);
</script>

{#if moves.length > 0}
  <section class="first-moves" aria-label={FIRST_MOVES_TITLE} data-testid="first-moves">
    <header class="head">
      <span class="eyebrow">{FIRST_MOVES_TITLE}</span>
      <span class="count" data-testid="first-moves-count">{doneCount} of {moves.length}</span>
    </header>
    <ol class="list">
      {#each moves as move (move.id)}
        <li
          class="move"
          class:done={move.state === "done"}
          class:current={move.state === "current"}
          data-testid={`first-move-${move.id}`}
          data-state={move.state}
        >
          <div class="row">
            <span class="mark" aria-hidden="true">
              {#if move.state === "done"}
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>
              {:else}
                <span class="dot"></span>
              {/if}
            </span>
            <span class="title">{move.title}</span>
            {#if move.state === "done"}<span class="sr-only">done</span>{/if}
          </div>
          {#if move.state === "current"}
            <p class="body">{move.body}</p>
            <div class="actions">
              <button
                type="button"
                class="btn primary"
                data-testid={`first-move-action-${move.id}`}
                disabled={busy !== null}
                aria-busy={busy === move.id}
                onclick={() => void run(move.id, () => onmove(move.id))}
              >
                {busy === move.id ? "Opening…" : FIRST_MOVES_COPY[move.id].cta}
              </button>
              {#if move.id === "coding-tools" && oncodex}
                <button
                  type="button"
                  class="btn"
                  data-testid="first-move-action-codex"
                  disabled={busy !== null}
                  aria-busy={busy === "codex"}
                  onclick={() => void run("coding-tools", () => oncodex!(), "codex")}
                >
                  {busy === "codex" ? "Opening…" : "Open in Codex"}
                </button>
              {/if}
            </div>
            {#if errors[move.id]}
              <p class="error" role="alert" data-testid={`first-move-error-${move.id}`}>{errors[move.id]}</p>
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .first-moves {
    width: 100%;
    max-width: 760px;
    padding: 4px 0 0;
    color: var(--text-1, inherit);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0 2px 8px;
  }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }
  .count {
    font-size: 12px;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
    font-variant-numeric: tabular-nums;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  }
  .move {
    padding: 12px 2px;
    border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    display: inline-flex;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
    color: var(--text-1, inherit);
    flex: 0 0 auto;
  }
  .done .mark {
    border-color: transparent;
    background: var(--accent, #22c55e);
    color: #fff;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--text-3, rgba(127, 127, 127, 0.9));
  }
  .current .dot {
    background: var(--text-1, currentColor);
  }
  .title {
    font-size: 14px;
    font-weight: 550;
  }
  .done .title {
    color: var(--text-3, rgba(127, 127, 127, 0.9));
    text-decoration: line-through;
    text-decoration-color: rgba(127, 127, 127, 0.5);
  }
  .body {
    margin: 8px 0 0 28px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--text-2, inherit);
    max-width: 56ch;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0 0 28px;
  }
  .btn {
    font: inherit;
    font-size: 13px;
    min-height: 34px;
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
    background: transparent;
    color: var(--text-1, inherit);
    cursor: pointer;
  }
  .btn.primary {
    background: var(--text-1, #111);
    color: var(--bg, #fff);
    border-color: transparent;
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .btn:focus-visible {
    outline: 2px solid var(--text-2, currentColor);
    outline-offset: 2px;
  }
  .error {
    margin: 8px 0 0 28px;
    font-size: 12px;
    color: var(--danger, #dc2626);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
