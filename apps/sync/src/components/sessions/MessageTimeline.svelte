<script lang="ts">
  // The session transcript timeline. Presentation-pure. Renders four states —
  // loaded, skeleton (shimmer rows), empty (session hero), loading (loaded
  // timeline + "loading older messages" spinner row at top) — plus day/unread
  // dividers, system rows, grouped messages, interleaved agent activity, and
  // the typing row.
  //
  // Lifted from the parked workspace timeline with the scroll-to-event
  // deep-link landing effect and the message edit/delete permission mirror
  // both removed: a session transcript has no deep-linkable room history and
  // no per-message ownership rights to mirror.
  import ActivityRow from './ActivityRow.svelte';
  import DayDivider from './DayDivider.svelte';
  import MessageRow from './MessageRow.svelte';
  import SystemMessageRow from './SystemMessageRow.svelte';
  import TimelineSkeleton from './TimelineSkeleton.svelte';
  import TypingIndicatorRow from './TypingIndicatorRow.svelte';
  import UnreadDivider from './UnreadDivider.svelte';
  import './sessions-tokens.css';
  import { tick } from 'svelte';
  import { buildTimelineItems } from './session-types';
  import type {
    WsMember,
    WsMessage,
    WsScreenState,
    WsTimelineActivity,
  } from './session-types';

  interface Props {
    /** The session's own title — what the empty hero and the log label read. */
    sessionTitle: string;
    /** Optional secondary line under the hero title (company, repo, cwd…). */
    sessionSubtitle?: string;
    messages: WsMessage[];
    members: WsMember[];
    typing?: string[];
    unreadFirstId?: string;
    state?: WsScreenState;
    oncomposeclick?: () => void;
    /**
     * Agent activity rows, interleaved into the stream by `createdAt`.
     * ADDITIVE — omitting this prop produces a byte-identical timeline, which
     * the story test pins.
     */
    activity?: WsTimelineActivity[];
    /** A permission row was approved/denied from the stream. */
    onactivityapprove?: (itemId: string) => void;
    onactivitydeny?: (itemId: string) => void;
  }

  let {
    sessionTitle,
    sessionSubtitle = '',
    messages,
    members,
    typing = [],
    unreadFirstId,
    // Renamed on destructure: a local binding literally named `state` turns
    // every `$state(...)` in this scope into a store subscription
    // (svelte store_rune_conflict).
    state: screenState = 'loaded',
    oncomposeclick,
    activity = [],
    onactivityapprove,
    onactivitydeny,
  }: Props = $props();

  const memberMap = $derived(new Map(members.map((m) => [m.uid, m])));
  const items = $derived(buildTimelineItems(messages, unreadFirstId, activity));
  const typers = $derived(
    typing.map((uid) => memberMap.get(uid)).filter((m): m is WsMember => m !== undefined),
  );

  let scrollEl = $state<HTMLElement | null>(null);

  // Transcript convention: land at the NEWEST end. Snap to the bottom when the
  // session changes or a new newest message arrives while the reader is
  // already near the bottom; never yank a reader who scrolled up into history.
  let bottomAnchorKey: string | undefined;
  $effect(() => {
    // An empty session must not consume the "session changed" transition: the
    // first render of a freshly opened session has no rows yet, and recording
    // the key there made the later rows-arrived pass look like an in-place
    // update (which only snaps when already near the bottom).
    if (messages.length === 0) return;
    const last = messages[messages.length - 1]!;
    const key = `${sessionTitle}::${last.id}`;
    if (key === bottomAnchorKey) return;
    const sessionChanged =
      bottomAnchorKey === undefined || !bottomAnchorKey.startsWith(`${sessionTitle}::`);
    bottomAnchorKey = key;
    const el = scrollEl;
    const nearBottom =
      el !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (!sessionChanged && !nearBottom) return;
    void tick().then(() => {
      const target = scrollEl;
      if (target) target.scrollTop = target.scrollHeight;
    });
  });
</script>

<div class="ws-timeline" data-testid="ws-timeline" data-state={screenState}>
  {#if screenState === 'skeleton'}
    <TimelineSkeleton />
  {:else if screenState === 'empty'}
    <div class="empty-hero" data-testid="ws-timeline-empty">
      <span class="hero-glyph" aria-hidden="true">›</span>
      <h2>{sessionTitle}</h2>
      <p>
        {#if sessionSubtitle}
          {sessionSubtitle} — nothing has happened yet. Send the first prompt and
          every message, tool call, and approval lands here.
        {:else}
          Nothing here yet. Send the first prompt and every message, tool call,
          and approval lands here.
        {/if}
      </p>
      <div class="hero-actions">
        <button type="button" class="primary" onclick={() => oncomposeclick?.()}>
          Send the first prompt
        </button>
      </div>
    </div>
  {:else}
    <div
      class="scroll"
      role="log"
      aria-label={`Transcript for ${sessionTitle}`}
      bind:this={scrollEl}
    >
      {#if screenState === 'loading'}
        <div class="loading-older" data-testid="ws-loading-older">
          <span class="spinner" aria-hidden="true"></span>
          Loading older messages…
        </div>
      {/if}

      {#each items as item (item.key)}
        {#if item.type === 'day'}
          <DayDivider label={item.label} />
        {:else if item.type === 'unread'}
          <UnreadDivider />
        {:else if item.type === 'system'}
          <SystemMessageRow message={item.message} />
        {:else if item.type === 'activity'}
          <!-- Agent work, IN the stream. `ActivityRow` is the lifted component
               untouched — this wrapper only adds the output link. An activity
               row is never a message: no reactions, no thread, no edit. -->
          <div class="activity-anchor" data-testid="ws-timeline-activity" data-activity-id={item.item.id}>
            <ActivityRow
              item={item.item}
              onapprove={onactivityapprove}
              ondeny={onactivitydeny}
            />
            {#if item.link}
              <a
                class="activity-link"
                data-testid="ws-activity-link"
                href={item.link}
                target="_blank"
                rel="noreferrer noopener"
              >
                View output
              </a>
            {/if}
          </div>
        {:else}
          <div class="event-anchor" data-event-id={item.message.id}>
            <MessageRow
              message={item.message}
              author={memberMap.get(item.message.authorUid)}
              grouped={item.grouped}
            />
          </div>
        {/if}
      {/each}
    </div>

    <TypingIndicatorRow {typers} />
  {/if}
</div>

<style>
  .ws-timeline {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--v4-space-2) 0 var(--v4-space-2);
    display: flex;
    flex-direction: column;
  }

  /* Bottom-anchor the conversation without justify-content: flex-end (which
     breaks upward scrolling in overflow containers). */
  .scroll > :global(:first-child) {
    margin-top: auto;
  }

  /* Activity anchor. Layout-inert: it adds no padding of its own, so
     `ActivityRow`'s shipped rhythm is what the stream shows. The link chip
     reuses the metadata type + text tokens — no new color, no restyle of the
     row itself. */
  .activity-link {
    display: inline-block;
    margin: 0 0 var(--v4-space-2) 44px;
    font-size: var(--type-metadata);
    color: var(--v4-text-2);
  }

  .activity-link:hover {
    color: var(--v4-text-1);
  }

  .loading-older {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2) 0 var(--v4-space-3);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--v4-hairline);
    border-top-color: var(--v4-text-2);
    border-radius: 50%;
    animation: ws-spin 0.9s linear infinite;
  }

  @keyframes ws-spin {
    100% {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  .empty-hero {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--v4-space-2);
    padding: var(--v4-space-6);
    text-align: center;
  }

  .hero-glyph {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    margin-bottom: var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: 50%;
    background: var(--v4-raised);
    font-size: 24px;
    color: var(--v4-text-2);
    user-select: none;
  }

  .empty-hero h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--v4-text-1);
  }

  .empty-hero p {
    margin: 0;
    max-width: 380px;
    font-size: var(--type-body);
    line-height: 1.5;
    color: var(--v4-text-2);
  }

  .hero-actions {
    display: flex;
    gap: var(--v4-space-2);
    margin-top: var(--v4-space-3);
  }

  .hero-actions button {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-4);
    border-radius: var(--v4-radius-button);
    font-family: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .hero-actions .primary {
    border: 1px solid transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }
</style>
