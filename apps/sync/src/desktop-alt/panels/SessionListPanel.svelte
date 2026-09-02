<script lang="ts">
  /**
   * Left column of the Sessions page: what this app is driving right now, and
   * what it drove before.
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
    onnew?: () => void;
    onresume?: (session: AgentSession) => void;
  }

  let { activeSessionId, onselect, onnew, onresume }: Props = $props();

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
</script>

<aside class="session-list" data-testid="session-list-panel" aria-label="Sessions">
  <div class="list-head">
    <span class="list-title">Sessions</span>
    <button type="button" class="new" data-testid="session-new" onclick={() => onnew?.()}>
      New session
    </button>
  </div>

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
              onclick={() => onselect?.(session.sessionId)}
            >
              <span class="row-top">
                <span class={`pill phase-${session.phase}`} data-testid="session-phase-pill">
                  {PHASE_LABEL[session.phase]}
                </span>
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
      <p class="group-note">No other sessions observed on this machine.</p>
    {:else}
      <ul class="rows">
        {#each visibleHistory as session (session.id)}
          <li class="history-row" data-testid="session-history-row" data-session-id={session.id}>
            <div class="row static">
              <span class="row-top">
                <span class="pill tool">{session.tool}</span>
                <span class="row-title">{session.project || session.company || session.cwd}</span>
              </span>
              <span class="row-meta">
                <span class="mono">{session.company || 'no company'}</span>
                <span class="mono">{relativeActivity(session.lastActivityAt, now)}</span>
              </span>
            </div>
            {#if session.tool === 'claude'}
              <button
                type="button"
                class="resume"
                data-testid="session-resume"
                onclick={() => onresume?.(session)}
              >
                Resume
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if history.length > visibleHistory.length}
        <button
          type="button"
          class="more"
          data-testid="session-history-more"
          onclick={() => (historyLimit += HISTORY_PAGE)}
        >
          Show {Math.min(HISTORY_PAGE, history.length - visibleHistory.length)} more
        </button>
      {/if}
    {/if}
  </section>
</aside>

<style>
  .session-list {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4);
    min-height: 0;
    overflow-y: auto;
    padding: var(--v4-space-3);
    border-right: 1px solid var(--v4-hairline);
    font-family: var(--font-sans);
  }

  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
  }

  .list-title {
    font-size: var(--type-body);
    font-weight: 500;
    color: var(--v4-text-1);
  }

  .new {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-3);
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font-family: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    margin: 0;
    font-size: var(--type-metadata);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }

  .count {
    font-variant-numeric: tabular-nums;
    color: var(--v4-idle);
  }

  .group-note {
    margin: 0;
    font-size: var(--type-metadata);
    line-height: 1.4;
    color: var(--v4-text-3);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 6px var(--v4-space-2);
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row.static {
    cursor: default;
  }

  button.row:hover {
    background: var(--v4-control-faint);
  }

  button.row.selected {
    border-color: var(--v4-hairline);
    background: var(--v4-active-row);
  }

  .row-top {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .row-title {
    flex: 1;
    min-width: 0;
    font-size: var(--type-body);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    font-size: 10px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--v4-text-2);
  }

  .pill.phase-working {
    border-color: var(--v4-ok);
    color: var(--v4-ok);
  }

  .pill.phase-needsYou {
    border-color: var(--v4-warn);
    color: var(--v4-warn);
  }

  .pill.phase-ended {
    color: var(--v4-idle);
  }

  .pending-chip {
    flex: none;
    min-width: 16px;
    padding: 0 4px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-warn, var(--v4-control-faint));
    color: var(--v4-primary-fg);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .history-row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
  }

  .history-row .row {
    flex: 1;
    min-width: 0;
  }

  .resume,
  .more {
    flex: none;
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-raised);
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .resume:hover,
  .more:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }
</style>
