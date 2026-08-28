<script lang="ts">
  /**
   * Work-mesh thread detail view (US-008).
   *
   * Renders the durable thread state as last reconciled from REST. The host
   * re-fetches on every `hq/{companyUid}/thread/{id}` wake (retained
   * THREAD_META snapshots replay for late subscribers) and passes the fresh
   * thread down — this component never fetches.
   */
  import { THREAD_STATUS_LABEL, type WorkMeshThread } from "./thread-model";
  import "../chat/chat-tokens.css";

  interface Props {
    thread: WorkMeshThread | null;
    loading?: boolean;
    loadError?: string | null;
    onback?: () => void;
  }

  let { thread, loading = false, loadError = null, onback }: Props = $props();
</script>

<div class="thread-detail" data-testid="board-thread-detail">
  <header class="detail-head">
    <button
      type="button"
      class="back-btn"
      data-testid="thread-detail-back"
      onclick={() => onback?.()}>← Board</button
    >
  </header>

  {#if loading && !thread}
    <p class="detail-empty" role="status">Loading thread…</p>
  {:else if loadError && !thread}
    <p class="detail-empty" role="alert">{loadError}</p>
  {:else if !thread}
    <p class="detail-empty" role="status">Thread not found.</p>
  {:else}
    <h1 class="detail-title">{thread.title}</h1>
    <dl class="detail-fields">
      <div class="field-row">
        <dt>STATUS</dt>
        <dd data-testid="thread-detail-status">
          {THREAD_STATUS_LABEL[thread.status]}
        </dd>
      </div>
      <div class="field-row">
        <dt>PROJECT</dt>
        <dd>{thread.project || "—"}</dd>
      </div>
      <div class="field-row">
        <dt>STORY</dt>
        <dd>{thread.storyId ?? "—"}</dd>
      </div>
      <div class="field-row">
        <dt>ACTOR</dt>
        <dd>{thread.actor ?? "—"}</dd>
      </div>
      <div class="field-row">
        <dt>UPDATED</dt>
        <dd>{thread.updatedAt ?? "—"}</dd>
      </div>
      <div class="field-row">
        <dt>THREAD</dt>
        <dd>{thread.threadId}</dd>
      </div>
    </dl>
    {#if thread.note}
      <section class="detail-note" aria-label="Latest note">
        <h2 class="note-label">LATEST NOTE</h2>
        <p class="note-body" data-testid="thread-detail-note">{thread.note}</p>
      </section>
    {/if}
  {/if}
</div>

<style>
  .thread-detail {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    padding: 20px;
    font: 400 13px/1.45 var(--font-ui);
    color: var(--t1);
  }

  .detail-head {
    display: flex;
  }

  .back-btn {
    appearance: none;
    padding: 3px 10px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .back-btn:hover {
    color: var(--t1);
    background: var(--hover);
  }

  .detail-empty {
    margin: 8px 0;
    color: var(--t3);
  }

  .detail-title {
    margin: 0;
    color: var(--t1);
    font-size: 17px;
    font-weight: 600;
  }

  .detail-fields {
    margin: 0;
    max-width: 560px;
  }

  .field-row {
    display: grid;
    grid-template-columns: 6.5rem 1fr;
    gap: 0.5rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }

  .field-row dt {
    color: var(--t3);
    font-size: 9px;
    letter-spacing: 0.1em;
  }

  .field-row dd {
    margin: 0;
    color: var(--t1);
    font-size: 12px;
    word-break: break-word;
  }

  .note-label {
    margin: 0 0 6px;
    color: var(--t2);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
  }

  .note-body {
    margin: 0;
    color: var(--t2);
    font-size: 13px;
    white-space: pre-wrap;
  }
</style>
