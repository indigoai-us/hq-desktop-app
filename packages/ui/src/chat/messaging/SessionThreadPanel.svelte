<script lang="ts">
  /**
   * Side pane for an in-channel session. Same chrome as ReplyPanel (header,
   * close, column). Spike: local turns + composer. Host can swap the body
   * for a live SessionTranscript later without changing the open/close seam.
   */
  import type { SessionThread, SessionThreadTurn } from "./session-thread";

  interface Props {
    thread: SessionThread;
    onclose: () => void;
    onexpand?: (thread: SessionThread) => void;
    onprompt?: (thread: SessionThread, text: string) => void;
  }

  let { thread, onclose, onexpand, onprompt }: Props = $props();
  let draft = $state("");

  function send(): void {
    const text = draft.trim();
    if (!text) return;
    draft = "";
    onprompt?.(thread, text);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const originLabel = $derived(
    thread.origin.kind === "message"
      ? thread.origin.author
      : `#${thread.origin.channelTitle}`,
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
    <span class="sep">·</span>
    <span class="status" data-status={thread.status}>{thread.status}</span>
  </div>

  <div class="turns" data-testid="session-thread-turns">
    {#each thread.turns as turn (turn.id)}
      {@render turnRow(turn)}
    {/each}
  </div>

  <div class="composer">
    <textarea
      class="draft"
      bind:value={draft}
      rows="3"
      placeholder="Prompt this session…"
      data-testid="session-thread-composer"
      onkeydown={onKey}
    ></textarea>
    <button
      type="button"
      class="send"
      data-testid="session-thread-send"
      disabled={!draft.trim()}
      onclick={send}
    >
      Send
    </button>
  </div>
</aside>

{#snippet turnRow(turn: SessionThreadTurn)}
  {#if turn.role === "tools"}
    <div class="turn tools" data-testid="session-thread-tools">{turn.text}</div>
  {:else if turn.role === "system"}
    <div class="turn system">{turn.text}</div>
  {:else if turn.role === "user"}
    <div class="turn user" data-testid="session-thread-user">{turn.text}</div>
  {:else}
    <div class="turn assistant" data-testid="session-thread-assistant">{turn.text}</div>
  {/if}
{/snippet}

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

  .session-header-copy {
    min-width: 0;
  }

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
  }

  .who {
    color: var(--t1, inherit);
    font-weight: 600;
  }

  .agent-mark {
    font-size: 10px;
  }

  .status[data-status="running"] {
    color: var(--t2, #c8c8d0);
  }

  .turns {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .turn {
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .turn.system,
  .turn.tools {
    color: var(--t3, #9a9aa3);
    font-size: 12px;
  }

  .turn.user {
    align-self: flex-end;
    padding: 8px 12px;
    border-radius: 14px;
    background: var(--v4-control-faint, rgba(255, 255, 255, 0.06));
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  }

  .draft {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
    border-radius: 10px;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 8px 10px;
  }

  .send {
    align-self: flex-end;
    border: 0;
    border-radius: 8px;
    padding: 6px 12px;
    background: var(--v4-text-1, #eee);
    color: var(--v4-ground, #111);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .send:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
