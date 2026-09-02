<script lang="ts">
  /**
   * The sessions drawer: what this app is driving right now, and what it drove
   * before.
   *
   * It is an OVERLAY, not a column. A chat surface earns its width by not
   * spending it on navigation, so this slides over the conversation, closes on
   * Escape or a scrim click, and closes itself the moment you pick something.
   *
   * TWO stores, deliberately, because they answer two different questions:
   *   - `liveSessionStore.sessions` is the in-app registry — sessions THIS app
   *     started and can still send to. Those rows are selectable.
   *   - `sessionsStore.sessions` is Mission Control's best-effort observation of
   *     every Claude/Codex session on the machine, in-app or not. Those rows are
   *     read-only history here; a Claude row offers Resume, which starts a NEW
   *     in-app session against that CLI transcript.
   * A history row that is already live in-app is dropped from History so the
   * same session never appears twice.
   */
  import { onMount } from 'svelte';
  import { liveSessionStore, type SessionPhase } from '../lib/live-session-store.svelte';
  import { sessionsStore, startSessionsStore } from '../lib/sessions-store.svelte';
  import { relativeActivity, type AgentSession } from '../lib/sessions';

  interface Props {
    activeSessionId?: string;
    onselect?: (sessionId: string) => void;
    onresume?: (session: AgentSession) => void;
    /** Dismiss the drawer — scrim, Escape, or a chosen row. */
    onclose?: () => void;
  }

  let { activeSessionId, onselect, onresume, onclose }: Props = $props();

  /** How many history rows to show before the "show more" reveal. */
  const HISTORY_PAGE = 12;
  let historyLimit = $state(HISTORY_PAGE);

  // Monotonic tick so relative labels age on their own between snapshots.
  let now = $state(Date.now());

  onMount(() => {
    // Both stores are lifetime singletons and idempotent to start.
    startSessionsStore();
    void liveSessionStore.refreshList();
    const tick = setInterval(() => {
      now = Date.now();
    }, 15_000);
    return () => clearInterval(tick);
  });

  const PHASE_LABEL: Record<SessionPhase, string> = {
    starting: 'Starting',
    idle: 'Idle',
    working: 'Working',
    needsYou: 'Needs you',
    ended: 'Ended',
  };

  const live = $derived(liveSessionStore.sessions);
  const liveIds = $derived(new Set(live.map((session) => session.sessionId)));
  const history = $derived(
    sessionsStore.sessions.filter((session) => !liveIds.has(session.id)),
  );
  const visibleHistory = $derived(history.slice(0, historyLimit));

  function choose(sessionId: string) {
    onselect?.(sessionId);
    onclose?.();
  }

  function resume(session: AgentSession) {
    onresume?.(session);
    onclose?.();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose?.();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="drawer-layer" data-testid="session-list-panel">
  <button
    type="button"
    class="scrim"
    aria-label="Close sessions"
    data-testid="sessions-drawer-scrim"
    onclick={() => onclose?.()}
  ></button>

  <aside class="drawer" aria-label="Sessions">
    <section class="group" aria-labelledby="session-live-heading">
      <h3 id="session-live-heading" class="group-head">
        Live <span class="count">{live.length}</span>
      </h3>

      {#if liveSessionStore.listError}
        <p class="group-note" role="alert">{liveSessionStore.listError}</p>
      {:else if live.length === 0}
        <p class="group-note">No session running in the app yet.</p>
      {:else}
        <ul class="rows">
          {#each live as session (session.sessionId)}
            <li>
              <button
                type="button"
                class="row"
                class:selected={session.sessionId === activeSessionId}
                data-testid="session-live-row"
                data-session-id={session.sessionId}
                aria-current={session.sessionId === activeSessionId ? 'true' : undefined}
                onclick={() => choose(session.sessionId)}
              >
                <span class="row-top">
                  <span class={`dot phase-${session.phase}`} data-testid="session-phase-pill"
                    aria-label={PHASE_LABEL[session.phase]}></span>
                  <span class="row-title">{session.company ?? 'No company'}</span>
                  {#if session.pendingCount > 0}
                    <span class="pending-chip">{session.pendingCount}</span>
                  {/if}
                </span>
                <span class="row-meta">
                  <span class="mono">{session.model ?? 'default model'}</span>
                  <span class="mono">{relativeActivity(session.lastActivityAt, now)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="group" aria-labelledby="session-history-heading">
      <h3 id="session-history-heading" class="group-head">
        History <span class="count">{history.length}</span>
      </h3>

      {#if sessionsStore.loading}
        <p class="group-note">Looking for sessions on this machine…</p>
      {:else if history.length === 0}
        <p class="group-note">Nothing else on this machine.</p>
      {:else}
        <ul class="rows">
          {#each visibleHistory as session (session.id)}
            <li class="history-row" data-testid="session-history-row">
              <span class="row-top">
                <span class="row-title">{session.company || 'No company'}</span>
                {#if session.tool === 'claude'}
                  <button
                    type="button"
                    class="resume"
                    data-testid="session-resume"
                    onclick={() => resume(session)}
                  >
                    Resume
                  </button>
                {/if}
              </span>
              <span class="row-meta">
                <span class="mono">{session.model || session.tool}</span>
                <span class="mono">{relativeActivity(session.lastActivityAt, now)}</span>
              </span>
            </li>
          {/each}
        </ul>
        {#if history.length > visibleHistory.length}
          <button
            type="button"
            class="more"
            onclick={() => (historyLimit += HISTORY_PAGE)}
          >
            Show more
          </button>
        {/if}
      {/if}
    </section>
  </aside>
</div>

<style>
  .drawer-layer {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
  }

  .scrim {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: var(--ws-scrim, rgba(0, 0, 0, 0.32));
    cursor: default;
  }

  .drawer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    width: 264px;
    max-width: 78%;
    height: 100%;
    overflow-y: auto;
    padding: var(--v4-space-3) var(--v4-space-2);
    border-right: 1px solid var(--v4-hairline);
    /* The v4 popover surface is deliberately translucent and expects its own
       glass filter — without the filter it reads as a thin wash over the chat
       rather than a panel sitting above it. */
    background: var(--v4-popover-strong, var(--v4-popover, var(--v4-raised)));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover, none);
    font-family: var(--font-sans);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .group-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    padding: 0 var(--v4-space-2);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .count {
    font-family: var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0;
  }

  .group-note {
    margin: 0;
    padding: 4px var(--v4-space-2);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row,
  .history-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 6px var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    text-align: left;
  }

  .row {
    cursor: pointer;
  }

  .row:hover {
    background: var(--v4-active-row);
  }

  .row.selected {
    background: color-mix(in srgb, var(--v4-text-1) 8%, transparent);
  }

  .row-top {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .row-title {
    flex: 1;
    min-width: 0;
    font-size: var(--type-metadata);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-text-3);
  }

  .dot.phase-working,
  .dot.phase-needsYou {
    background: var(--v4-text-1);
  }

  .dot.phase-ended {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--v4-text-3);
  }

  .pending-chip {
    flex: none;
    min-width: 16px;
    padding: 0 4px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint, var(--v4-active-row));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    line-height: 15px;
    text-align: center;
    color: var(--v4-text-2);
  }

  .row-meta {
    display: flex;
    gap: 8px;
    padding-left: 12px;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resume,
  .more {
    flex: none;
    height: 20px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .resume:hover,
  .more:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .more {
    align-self: flex-start;
    margin: 4px 0 0 var(--v4-space-2);
  }
</style>
