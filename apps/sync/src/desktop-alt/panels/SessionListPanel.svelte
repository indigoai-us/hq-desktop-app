<script lang="ts">
  /** One chronological conversation list. A provider transcript and the
   * app-owned process resuming it are two representations of the same session,
   * so navigation merges them instead of inventing Live and History buckets. */
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  const motionDuration = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  import { liveSessionStore, type SessionPhase } from '../lib/live-session-store.svelte';
  import { sessionsStore, startSessionsStore } from '../lib/sessions-store.svelte';
  import { claudeCodeSessionUrl, relativeActivity, type AgentSession } from '../lib/sessions';

  interface Props {
    activeSessionId?: string;
    onselect?: (sessionId: string) => void;
    onopen?: (session: AgentSession) => Promise<boolean | void> | boolean | void;
    /** Dismiss the drawer — scrim, Escape, or a chosen row. */
    onclose?: () => void;
  }

  let { activeSessionId, onselect, onopen, onclose }: Props = $props();

  const SESSION_PAGE = 18;
  let sessionLimit = $state(SESSION_PAGE);
  let openingId = $state<string | null>(null);

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
  const resumedIds = $derived(new Set(live.flatMap((session) => session.resumedFrom ? [session.resumedFrom] : [])));
  const history = $derived(
    sessionsStore.sessions.filter((session) => !liveIds.has(session.id) && !resumedIds.has(session.id)),
  );
  const rows = $derived([
    ...live.map((session) => ({
      key: `live:${session.sessionId}`,
      sessionId: session.sessionId,
      history: null,
      title: session.title || session.project || session.company || 'Untitled session',
      company: session.company ?? '',
      model: session.model ?? session.tool,
      lastActivityAt: session.lastActivityAt,
      phase: session.phase,
      pendingCount: session.pendingCount,
      external: false,
    })),
    ...history.map((session) => ({
      key: `history:${session.id}`,
      sessionId: null,
      history: session,
      title: session.title || session.project || 'Untitled session',
      company: session.company,
      model: session.model || session.tool,
      lastActivityAt: session.lastActivityAt,
      phase: null,
      pendingCount: 0,
      // Remote Control sessions open on claude.ai rather than in the app.
      external: claudeCodeSessionUrl(session) !== null,
    })),
  ].sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)));
  const visibleRows = $derived(rows.slice(0, sessionLimit));

  function choose(sessionId: string) {
    onselect?.(sessionId);
    onclose?.();
  }

  async function openHistory(session: AgentSession) {
    if (openingId) return;
    openingId = session.id;
    try {
      const opened = await onopen?.(session);
      if (opened !== false) onclose?.();
    } finally {
      openingId = null;
    }
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
    transition:fade={{ duration: motionDuration }}
    aria-label="Close sessions"
    data-testid="sessions-drawer-scrim"
    onclick={() => onclose?.()}
  ></button>

  <aside class="drawer" aria-label="Sessions" transition:fly={{ x: -280, duration: motionDuration }}>
    <section class="group" aria-labelledby="sessions-heading">
      <h3 id="sessions-heading" class="group-head">
        Sessions <span class="count">{rows.length}</span>
        <button class="close" type="button" aria-label="Close sessions sidebar" onclick={() => onclose?.()}>×</button>
      </h3>

      {#if liveSessionStore.listError}
        <p class="group-note" role="alert">{liveSessionStore.listError}</p>
      {:else if sessionsStore.loading && rows.length === 0}
        <p class="group-note">Looking for sessions on this machine…</p>
      {:else if rows.length === 0}
        <p class="group-note">No sessions on this machine yet.</p>
      {:else}
        <ul class="rows">
          {#each visibleRows as row (row.key)}
            <li data-testid={row.history ? 'session-history-row' : undefined}>
              <button
                type="button"
                class="row"
                class:selected={row.sessionId === activeSessionId}
                data-testid={row.history ? 'session-resume' : 'session-live-row'}
                data-session-id={row.sessionId ?? row.history?.id}
                aria-current={row.sessionId === activeSessionId ? 'true' : undefined}
                aria-busy={openingId === row.history?.id ? 'true' : undefined}
                title={row.external ? 'Opens on claude.ai' : undefined}
                disabled={openingId !== null}
                onclick={() => row.history ? void openHistory(row.history) : choose(row.sessionId!)}
              >
                <span class="row-top">
                  {#if row.phase}
                    <span class={`dot phase-${row.phase}`} data-testid="session-phase-pill"
                      aria-label={PHASE_LABEL[row.phase]}></span>
                  {/if}
                  <span class="row-title">{row.title}</span>
                  {#if row.external}
                    <span class="external" aria-hidden="true">↗</span>
                  {/if}
                  {#if row.pendingCount > 0}
                    <span class="pending-chip">{row.pendingCount}</span>
                  {/if}
                </span>
                <span class="row-meta">
                  {#if openingId === row.history?.id}
                    <span>Opening…</span>
                  {:else}
                    {#if row.company}<span>{row.company}</span>{/if}
                    <span class="mono">{row.model}</span>
                    <span class="mono">{relativeActivity(row.lastActivityAt, now)}</span>
                  {/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        {#if rows.length > visibleRows.length}
          <button
            type="button"
            class="more"
            onclick={() => (sessionLimit += SESSION_PAGE)}
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
    min-height: 0;
    box-sizing: border-box;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
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

  .close { margin-left: auto; border: 0; background: transparent; color: inherit; font-size: 20px; cursor: pointer; width: 28px; height: 28px; border-radius: 6px; }
  .close:hover { background: var(--v4-active-row); }

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

  .row {
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

  .external {
    flex: none;
    font-size: 11px;
    color: var(--v4-text-3);
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
  }

  .more:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .more {
    cursor: pointer;
  }

  .more {
    align-self: flex-start;
    margin: 4px 0 0 var(--v4-space-2);
  }
</style>
