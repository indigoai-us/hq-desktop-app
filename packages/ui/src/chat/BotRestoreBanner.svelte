<script lang="ts">
  /**
   * Your bots are waiting — the one prompt after a fresh install or a move to
   * a new Mac.
   *
   * A reinstall takes away the half of a local bot that runs it and leaves the
   * half that IS it — identity, memory, conversations — untouched in HQ. This
   * banner is how a person finds that out without reading a notice inside each
   * bot's DM: one sentence, one action that brings them all back, and a
   * "Not now" the app remembers so it never asks again by itself.
   *
   * It shares the shell's banner slot with the recommended-update banner, so
   * it is non-blocking and reaches the person wherever they landed after
   * signing in. Results replace the prompt in place, one plain line per bot.
   */
  import type { BotRestoreResult } from "@hq/platform";

  import {
    BOT_RESTORE_ALL,
    BOT_RESTORE_ALL_BUSY,
    BOT_RESTORE_DISMISS,
    BOT_RESTORE_TITLE,
    botRestorePromptBody,
    botRestoreRowFailed,
    botRestoreRowLine,
    botRestoreSummary,
  } from "./bot-restore.js";

  interface Props {
    /** How many owned bots are not set up on this computer. */
    count: number;
    busy?: boolean;
    /** Set once a restore finished; the banner then reports instead of asking. */
    result?: BotRestoreResult | null;
    /** Plain sentence from a restore that could not run at all. */
    error?: string | null;
    onrestore?: () => void | Promise<void>;
    ondismiss?: () => void;
  }

  let {
    count,
    busy = false,
    result = null,
    error = null,
    onrestore,
    ondismiss,
  }: Props = $props();
</script>

<div class="bot-restore-banner" role="status" data-testid="bot-restore-banner">
  {#if result}
    <div class="restore-copy">
      <strong data-testid="bot-restore-summary">{botRestoreSummary(result)}</strong>
      <ul class="restore-results" data-testid="bot-restore-results">
        {#each result.bots ?? [] as row (row.agentUid)}
          <li class:failed={botRestoreRowFailed(row)} data-testid={`bot-restore-row-${row.name}`}>
            {botRestoreRowLine(row)}
          </li>
        {/each}
      </ul>
    </div>
    <div class="restore-actions">
      <button
        type="button"
        class="restore-dismiss"
        data-testid="bot-restore-done"
        onclick={() => ondismiss?.()}
      >
        Done
      </button>
    </div>
  {:else}
    <div class="restore-copy">
      <strong>{BOT_RESTORE_TITLE}</strong>
      <span>{botRestorePromptBody(count)}</span>
      {#if error}
        <span class="restore-error" role="alert" data-testid="bot-restore-error">{error}</span>
      {/if}
    </div>
    <div class="restore-actions">
      <button
        type="button"
        class="restore-run"
        data-testid="bot-restore-all"
        disabled={busy}
        aria-busy={busy}
        onclick={() => void onrestore?.()}
      >
        {busy ? BOT_RESTORE_ALL_BUSY : BOT_RESTORE_ALL}
      </button>
      <button
        type="button"
        class="restore-dismiss"
        data-testid="bot-restore-dismiss"
        disabled={busy}
        onclick={() => ondismiss?.()}
      >
        {BOT_RESTORE_DISMISS}
      </button>
    </div>
  {/if}
</div>

<style>
  .bot-restore-banner {
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

  .restore-copy {
    display: flex;
    flex: 1 1 220px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .restore-copy strong {
    font-weight: 600;
  }

  .restore-copy span {
    color: var(--v4-text-2, var(--t2, rgba(0, 0, 0, 0.62)));
  }

  .restore-error {
    color: var(--v4-danger, #b3261e);
  }

  .restore-results {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--v4-text-2, var(--t2, rgba(0, 0, 0, 0.62)));
  }

  .restore-results li.failed {
    color: var(--v4-danger, #b3261e);
  }

  .restore-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .restore-run,
  .restore-dismiss {
    margin: 0;
    border-radius: 6px;
    font: 500 12px/1 var(--font-ui, system-ui);
    cursor: pointer;
  }

  .restore-run {
    padding: 7px 12px;
    border: 0;
    background: var(--v4-text-1, #111);
    color: var(--v4-ground, #fff);
  }

  .restore-run:disabled,
  .restore-dismiss:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .restore-dismiss {
    padding: 7px 10px;
    border: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.12));
    background: transparent;
    color: var(--v4-text-2, inherit);
  }
</style>
