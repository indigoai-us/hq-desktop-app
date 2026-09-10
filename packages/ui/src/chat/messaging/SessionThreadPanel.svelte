<script lang="ts">
  /**
   * Side pane chrome for an in-channel session — same column as Thread.
   * The live transcript + composer is a host snippet (desktop Sessions store).
   */
  import type { Snippet } from "svelte";
  import type { SessionThread } from "./session-thread";

  interface Props {
    thread: SessionThread;
    onclose: () => void;
    onexpand?: (thread: SessionThread) => void;
    body?: Snippet<[SessionThread]>;
  }

  let { thread, onclose, onexpand, body }: Props = $props();

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    }
  }

  const originLabel = $derived(
    thread.origin.kind === "message"
      ? thread.origin.author
      : `#${thread.origin.channelTitle}`,
  );

  const taskLabel = $derived(
    thread.taskId
      ? thread.taskCreated
        ? `Created ${thread.taskId}`
        : thread.taskId
      : null,
  );
</script>

<svelte:window onkeydown={onKey} />

<aside class="session-panel" data-testid="session-thread-panel" data-session-id={thread.id}>
  <header class="session-header">
    <div class="session-header-copy">
      <h2 class="session-title" data-testid="session-thread-title">Session</h2>
      <p class="session-sub" data-testid="session-thread-subtitle">{thread.title}</p>
    </div>
    <div class="session-header-actions">
      {#if onexpand}
        <button
          type="button"
          class="ghost"
          data-testid="session-thread-expand"
          onclick={() => onexpand?.(thread)}
        >
          Open full
        </button>
      {/if}
      <button
        type="button"
        class="ghost"
        data-testid="session-thread-close"
        aria-label="Close session"
        onclick={onclose}
      >
        Close
      </button>
    </div>
  </header>

  {#if thread.origin.kind === "message"}
    <blockquote class="origin-quote" data-testid="session-thread-origin">
      <span class="origin-who">{originLabel}</span>
      <span class="origin-body">{thread.origin.excerpt}</span>
    </blockquote>
  {:else}
    <p class="origin-channel" data-testid="session-thread-origin">
      Channel session · {originLabel}
    </p>
  {/if}

  <div class="session-meta" data-testid="session-thread-actor">
    <span class="who">{thread.actorName}</span>
    {#if thread.actorKind === "agent"}
      <span class="agent-mark" title="Agent">✦</span>
    {/if}
    {#if taskLabel}
      <span class="sep">·</span>
      <span class="task" data-testid="session-thread-task">{taskLabel}</span>
    {/if}
  </div>

  <div class="session-body">
    {#if body}
      {@render body(thread)}
    {:else}
      <p class="fallback" data-testid="session-thread-fallback">
        Sessions run on the desktop app.
      </p>
    {/if}
  </div>
</aside>

<style>
  .session-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    background: var(--surface-panel, var(--v4-ground, #161618));
    border-left: 1px solid var(--line, var(--border, rgba(255, 255, 255, 0.12)));
    color: var(--t1, inherit);
    font: 400 13px/1.45 var(--font-ui, inherit);
  }

  .session-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
    flex-shrink: 0;
  }

  .session-header-copy { min-width: 0; }

  .session-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
  }

  .session-sub {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--t3, #9a9aa3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-header-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .ghost {
    border: 0;
    background: transparent;
    color: var(--t2, #c8c8d0);
    font: inherit;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
  }

  .ghost:hover {
    background: var(--v4-active-row, rgba(255, 255, 255, 0.06));
  }

  .origin-quote,
  .origin-channel {
    margin: 0;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.08));
    color: var(--t2, #c8c8d0);
    font-size: 12px;
  }

  .origin-quote {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 2px solid var(--t3, #6e6e76);
    margin: 8px 16px 0;
    padding: 6px 10px 10px;
    border-bottom: 0;
  }

  .origin-who {
    font-weight: 600;
    color: var(--t1, inherit);
  }

  .session-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 12px;
    color: var(--t3, #9a9aa3);
    flex-shrink: 0;
  }

  .who {
    color: var(--t1, inherit);
    font-weight: 600;
  }

  .agent-mark { font-size: 10px; }

  .session-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .fallback {
    margin: 16px;
    color: var(--t3, #9a9aa3);
  }
</style>
