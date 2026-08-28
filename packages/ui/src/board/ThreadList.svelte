<script lang="ts">
  /**
   * Work-mesh thread list for one company board section (US-008).
   * Rows link to the thread detail view via the `onopen` callback so the
   * host owns routing (no platform imports).
   */
  import { THREAD_STATUS_LABEL, type WorkMeshThread } from "./thread-model";
  import "../chat/chat-tokens.css";

  interface Props {
    threads: readonly WorkMeshThread[];
    loading?: boolean;
    onopen?: (thread: WorkMeshThread) => void;
  }

  let { threads, loading = false, onopen }: Props = $props();

  function when(thread: WorkMeshThread): string {
    if (!thread.updatedAt) return "";
    const t = Date.parse(thread.updatedAt);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleString();
  }
</script>

<div class="thread-list" data-testid="board-thread-list">
  {#if threads.length === 0}
    <p class="thread-empty" role="status">
      {loading ? "Loading threads…" : "No active work threads."}
    </p>
  {:else}
    <ul class="rows">
      {#each threads as thread (thread.companyUid + "/" + thread.threadId)}
        <li>
          <button
            type="button"
            class="thread-row"
            data-testid="board-thread-row"
            data-thread-id={thread.threadId}
            onclick={() => onopen?.(thread)}
          >
            <span class="row-main">
              <span class="row-title">{thread.title}</span>
              {#if thread.project}
                <span class="row-project">{thread.project}</span>
              {/if}
              {#if thread.note}
                <span class="row-note">{thread.note}</span>
              {/if}
            </span>
            <span class="row-side">
              <span
                class="status-chip"
                class:blocked={thread.status === "blocked"}
                class:done={thread.status === "done"}
                data-testid="thread-status"
                >{THREAD_STATUS_LABEL[thread.status]}</span
              >
              <span class="row-when">{when(thread)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .thread-list {
    min-width: 0;
    font: 400 13px/1.45 var(--font-ui);
    color: var(--t1);
  }

  .thread-empty {
    margin: 8px 0;
    color: var(--t3);
    font-size: 13px;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .thread-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s;
  }

  .thread-row:hover {
    background: var(--btn-bg);
    border-color: var(--line2);
  }

  .thread-row:focus-visible {
    outline: 2px solid var(--v4-control-border, var(--border));
    outline-offset: 2px;
  }

  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row-title {
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
  }

  .row-project {
    color: var(--t3);
    font-size: 11px;
  }

  .row-note {
    color: var(--t2);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 48ch;
  }

  .row-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex: 0 0 auto;
  }

  .status-chip {
    padding: 2px 8px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t2);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .status-chip.blocked {
    color: var(--warn-ink, #fbbf24);
  }

  .status-chip.done {
    color: var(--ok-ink, #4ade80);
  }

  .row-when {
    color: var(--t3);
    font-size: 10px;
  }
</style>
