<script lang="ts">
  /**
   * The centre column of the Sessions page: the transcript plus the decision
   * cards the session is blocked on.
   *
   * Composition only — `MessageTimeline` renders the stream, `PermissionCard`
   * and `QuestionCard` render the parked requests, and this component decides
   * that pending cards sit BELOW the transcript and ABOVE the composer (which
   * the page slots in beneath it). Nothing here invokes; every decision is
   * forwarded to the page as a callback.
   *
   * The one thing it adds on its own is markdown: assistant bodies are
   * rendered through the app's CSP-safe `renderMessageBodyMarkdown` (no new
   * dependency, no raw source HTML) and handed to the timeline as pre-rendered
   * HTML. System rows keep the plain-text path — they are our own one-liners.
   */
  import MessageTimeline from './MessageTimeline.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import { SESSION_AGENT_UID, SESSION_MEMBERS } from './transcript-adapter';
  import type { PendingCard } from './transcript-adapter';
  import type { WsActivityItem, WsMessage, WsScreenState } from './session-types';
  import { renderMessageBodyMarkdown } from '../../lib/messageMarkdown';
  import './sessions-tokens.css';

  interface Props {
    sessionTitle: string;
    sessionSubtitle?: string;
    messages: WsMessage[];
    activity: WsActivityItem[];
    pending: PendingCard[];
    state?: WsScreenState;
    /** Set while a decision is in flight so a card cannot double-fire. */
    busyRequestId?: string | null;
    onallowonce?: (requestId: string) => void;
    onallowsession?: (requestId: string) => void;
    ondenypermission?: (requestId: string, message: string) => void;
    onanswerquestion?: (
      requestId: string,
      answers: { questionId: string; values: string[] }[],
    ) => void;
    oncomposeclick?: () => void;
  }

  let {
    sessionTitle,
    sessionSubtitle = '',
    messages,
    activity,
    pending,
    state: screenState = 'loaded',
    busyRequestId = null,
    onallowonce,
    onallowsession,
    ondenypermission,
    onanswerquestion,
    oncomposeclick,
  }: Props = $props();

  /**
   * Rendered bodies, keyed by the body text itself. The timeline calls the
   * renderer for every visible row on every render, and a streaming turn
   * re-renders on every delta — without this, one long answer would re-parse
   * the whole transcript's markdown per keystroke of output. Keying on the
   * body (not the id) means a streaming row's growing text simply misses until
   * it settles, and the map is cleared rather than grown without bound.
   */
  const BODY_CACHE_LIMIT = 200;
  const bodyCache = new Map<string, string>();

  /**
   * Render the agent's own prose as markdown; leave everything else alone.
   * Returning null puts the row back on the plain-text path.
   */
  function renderBody(message: WsMessage): string | null {
    if (message.kind !== 'message') return null;
    if (message.authorUid !== SESSION_AGENT_UID) return null;
    if (!message.body) return null;
    const cached = bodyCache.get(message.body);
    if (cached !== undefined) return cached;
    const html = renderMessageBodyMarkdown(message.body);
    if (bodyCache.size >= BODY_CACHE_LIMIT) bodyCache.clear();
    bodyCache.set(message.body, html);
    return html;
  }
</script>

<div class="transcript" data-testid="session-transcript">
  <MessageTimeline
    {sessionTitle}
    {sessionSubtitle}
    {messages}
    members={SESSION_MEMBERS}
    {activity}
    state={screenState}
    {renderBody}
    {oncomposeclick}
  />

  {#if pending.length > 0}
    <div class="pending" data-testid="session-pending-cards">
      {#each pending as card (card.requestId)}
        {#if card.type === 'permission'}
          <PermissionCard
            requestId={card.requestId}
            toolName={card.toolName}
            input={card.input}
            suggestions={card.suggestions}
            busy={busyRequestId === card.requestId}
            onallowonce={onallowonce}
            onallowsession={onallowsession}
            ondeny={ondenypermission}
          />
        {:else}
          <QuestionCard
            requestId={card.requestId}
            questions={card.questions}
            busy={busyRequestId === card.requestId}
            onsubmit={onanswerquestion}
          />
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .transcript {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .pending {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    flex: none;
    padding: var(--v4-space-2) var(--v4-space-4) 0;
  }
</style>
