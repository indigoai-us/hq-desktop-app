<script lang="ts">
  // Right-side thread panel (US-022). Opens within MessagesShell — an overlay on
  // narrow widths, a third column on the wide desktop-alt layout — NOT a new
  // window, so the master/detail state stays coherent in one surface.
  //
  // Layout:
  //
  //   ┌─────────────────────────────┐
  //   │ ‹ Back / Close   Thread     │  header
  //   ├─────────────────────────────┤
  //   │ pinned root message bubble  │  (always shown at top)
  //   ├─────────────────────────────┤
  //   │ reply list  (<Conversation/>) │
  //   │ + composer (posts rootEventId) │
  //   └─────────────────────────────┘
  //
  // The replies + composer reuse the shared <Conversation/> primitive. The panel
  // owns the fetch (fetch_thread), the send (send_thread_reply with rootEventId
  // set), and the live thread:new-reply append. It also registers the open thread
  // with the backend (set_active_thread) so the SINGLE DM poll path re-fetches it
  // on a "thread" wake and emits thread:new-reply.
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import Conversation, { type ConversationMessage } from './Conversation.svelte';
  import AgentThinkingRow from './AgentThinkingRow.svelte';
  import { type ReactionEvent, dmScope, channelScope } from '../../lib/reactions';
  import { ReactionController } from '../../lib/reactionController.svelte';
  import { AgentThinkingController } from '../../lib/agentThinkingController.svelte';
  import { sanitizeVisibleIdentifiers } from '../../lib/visible-labels';
  import { effectiveReplyCount } from './thread-replies';

  // A thread message (root or reply) as returned by fetch_thread / carried on a
  // thread:new-reply event. Mirrors the Rust `ThreadReply` (camelCase).
  interface ThreadReplyRow extends ConversationMessage {
    fromEmail?: string;
  }

  interface ThreadView {
    root: ThreadReplyRow;
    replies: ThreadReplyRow[];
    replyCount?: number | null;
  }

  interface Props {
    // The root message being threaded. Identifies which thread to load + reply to.
    rootEventId: string;
    // "dm" | "channel" — selects the fetch query + the reply endpoint.
    scope: 'dm' | 'channel';
    // For a channel thread: the channel the root lives in.
    channelId?: string | null;
    // For a DM thread: the peer the root conversation is with (the reply recipient).
    withPersonUid?: string | null;
    // A title shown in the header (peer name or #channel). Cosmetic.
    title?: string;
    // Whether to render author names above incoming bubbles (channels: true).
    showAuthors?: boolean;
    // Close/back — returns to the main conversation.
    onclose: () => void;
    // Bubbled up so the parent can bump the root bubble's live reply-count in the
    // main conversation as replies land here.
    onreplycount?: (rootEventId: string, replyCount: number, lastReplyAt?: string | null) => void;
  }

  let {
    rootEventId,
    scope,
    channelId = null,
    withPersonUid = null,
    title = 'Thread',
    showAuthors = false,
    onclose,
    onreplycount,
  }: Props = $props();

  let root = $state<ThreadReplyRow | null>(null);
  let replies = $state<ThreadReplyRow[]>([]);
  let replyCount = $state(0);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loadGeneration = 0;

  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let sendGeneration = 0;

  // Dedupe set so an optimistic append + the live thread:new-reply (or a reload)
  // don't double-render the same reply.
  let seenIds = $state(new Set<string>());

  // Reactions (US-025) for the thread's replies. Replies share the PARENT
  // conversation's messageScope (dm:peer | chan:channelId), so this controller
  // MERGES its reply ids into the same active-conversation slot the main pane
  // owns — it passes clearOnDispose=false so closing the thread doesn't wipe the
  // still-open main pane's registration.
  const reactionScope = $derived(
    scope === 'channel' ? channelScope(channelId ?? '') : dmScope(withPersonUid ?? ''),
  );
  let reactionsCtl = $state<ReactionController | null>(null);
  let thinkingCtl = $state<AgentThinkingController | null>(null);

  $effect(() => {
    const s = reactionScope;
    const controller = new ReactionController(s, false);
    reactionsCtl = controller;
    return () => controller.dispose();
  });

  // Agent-thinking indicator. Channel threads load the channel roster; DM
  // threads supply an empty loader so a mention can never start a row.
  $effect(() => {
    const currentScope = scope;
    const currentChannelId = channelId;
    void rootEventId;
    const controller = new AgentThinkingController(async () => {
      if (currentScope !== 'channel' || !currentChannelId) return [];
      const resp = await invoke<{ members: Array<{ personUid: string; displayName: string }> }>(
        'list_channel_members',
        { channelId: currentChannelId },
      );
      return (resp.members ?? []).map((m) => ({
        personUid: m.personUid,
        displayName: m.displayName,
      }));
    });
    thinkingCtl = controller;
    return () => controller.dispose();
  });

  // Keep the thread's reply ids registered + loaded (skip optimistic local-* ids).
  $effect(() => {
    const controller = reactionsCtl;
    if (!controller) return;
    const ids = replies
      .filter((r) => !r.eventId.startsWith('local-'))
      .map((r) => r.eventId);
    void controller.setMessages(ids);
  });

  function appendReply(r: ThreadReplyRow): void {
    if (seenIds.has(r.eventId)) return;
    seenIds.add(r.eventId);
    replies = [...replies, r];
    thinkingCtl?.noteIncoming([r]);
  }

  interface ThreadIdentity {
    rootEventId: string;
    scope: 'dm' | 'channel';
    channelId: string | null;
    withPersonUid: string | null;
  }

  function captureIdentity(): ThreadIdentity {
    return {
      rootEventId,
      scope,
      channelId,
      withPersonUid,
    };
  }

  function identityIsCurrent(identity: ThreadIdentity): boolean {
    return (
      rootEventId === identity.rootEventId &&
      scope === identity.scope &&
      channelId === identity.channelId &&
      withPersonUid === identity.withPersonUid
    );
  }

  async function load(identity: ThreadIdentity): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    loadError = null;
    try {
      const view = await invoke<ThreadView>('fetch_thread', {
        scope: identity.scope,
        rootEventId: identity.rootEventId,
        channelId: identity.scope === 'channel' ? identity.channelId : null,
        withPersonUid: identity.scope === 'dm' ? identity.withPersonUid : null,
      });
      if (
        generation !== loadGeneration ||
        !identityIsCurrent(identity)
      ) return;
      root = view.root ?? null;
      // Server returns replies newest-first; render chronologically.
      const ordered = [...(view.replies ?? [])].reverse();
      seenIds = new Set(ordered.map((r) => r.eventId));
      replies = ordered;
      thinkingCtl?.noteIncoming(replies);
      replyCount = effectiveReplyCount(
        view.replyCount,
        view.root?.replyCount,
        ordered.length,
      );
      const lastReplyAt = ordered.at(-1)?.createdAt ?? null;
      onreplycount?.(identity.rootEventId, replyCount, lastReplyAt);
      // Register the open thread (+ already-seen reply ids) so the SINGLE poll
      // path emits thread:new-reply only for genuinely new replies.
      void invoke('set_active_thread', {
        rootEventId: identity.rootEventId,
        scope: identity.scope,
        channelId: identity.scope === 'channel' ? identity.channelId : null,
        withPersonUid: identity.scope === 'dm' ? identity.withPersonUid : null,
        seenReplyIds: [...seenIds],
      });
    } catch (err) {
      if (
        generation !== loadGeneration ||
        !identityIsCurrent(identity)
      ) return;
      loadError = typeof err === 'string' ? err : 'Could not load this thread';
      console.error('thread-panel: fetch_thread failed', err);
    } finally {
      if (
        generation === loadGeneration &&
        identityIsCurrent(identity)
      ) {
        loading = false;
      }
    }
  }

  async function sendReply(text: string): Promise<void> {
    if (!text || sending) return;
    const identity = captureIdentity();
    const generation = ++sendGeneration;
    sending = true;
    sendError = null;
    try {
      await invoke('send_thread_reply', {
        scope: identity.scope,
        rootEventId: identity.rootEventId,
        body: text,
        channelId: identity.scope === 'channel' ? identity.channelId : null,
        toPersonUid: identity.scope === 'dm' ? identity.withPersonUid : null,
      });
      if (
        generation !== sendGeneration ||
        !identityIsCurrent(identity)
      ) return;
      // Optimistic append — the durable copy lands server-side and reconciles on
      // the next thread:new-reply / reload.
      const optimistic: ThreadReplyRow = {
        eventId: `local-${identity.rootEventId}-${replies.length}-${text.length}`,
        fromPersonUid: 'me',
        fromEmail: '',
        fromDisplayName: 'You',
        body: text,
        details: null,
        prompt: null,
        createdAt: new Date().toISOString(),
        direction: 'out',
      };
      appendReply(optimistic);
      replyCount += 1;
      onreplycount?.(identity.rootEventId, replyCount, optimistic.createdAt);
      void thinkingCtl?.noteOutgoing(text);
    } catch (err) {
      if (
        generation !== sendGeneration ||
        !identityIsCurrent(identity)
      ) return;
      sendError = typeof err === 'string' ? err : 'Failed to send reply';
      console.error('thread-panel: send_thread_reply failed', err);
      thinkingCtl?.noteSendFailed();
    } finally {
      if (
        generation === sendGeneration &&
        identityIsCurrent(identity)
      ) {
        sending = false;
      }
    }
  }

  $effect(() => {
    const identity = captureIdentity();
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    function retainUnlistener(unlisten: () => void): void {
      const safe = safeUnlisten(unlisten);
      if (disposed) {
        safe();
        return;
      }
      unlisteners.push(safe);
    }

    function registerListener<T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ): void {
      void listen<T>(event, handler)
        .then(retainUnlistener)
        .catch((error: unknown) => {
          if (!disposed) {
            console.error(`thread-panel: failed to listen for ${event}`, error);
          }
        });
    }

    loadGeneration += 1;
    sendGeneration += 1;
    root = null;
    replies = [];
    seenIds = new Set();
    replyCount = 0;
    loading = false;
    loadError = null;
    sending = false;
    sendError = null;

    // A new reply landed in THIS thread (emitted by the SINGLE DM poll path on a
    // "thread" wake). Append it and bump the live count; ignore replies for other
    // roots.
    registerListener<{ rootEventId: string; reply: ThreadReplyRow; replyCount?: number }>(
      'thread:new-reply',
      (e) => {
        if (
          e.payload.rootEventId !== identity.rootEventId ||
          !identityIsCurrent(identity)
        ) return;
        appendReply(e.payload.reply);
        replyCount = Math.max(e.payload.replyCount ?? 0, replies.length);
        onreplycount?.(
          identity.rootEventId,
          replyCount,
          e.payload.reply.createdAt ?? null,
        );
      },
    );

    // Reactions on a thread reply changed (US-025). The controller ignores events
    // for any scope other than this thread's parent conversation.
    registerListener<ReactionEvent>('message:reaction', (e) => {
      reactionsCtl?.applyEvent(e.payload);
    });

    void load(identity);

    return () => {
      disposed = true;
      loadGeneration += 1;
      sendGeneration += 1;
      for (const fn of unlisteners) fn();
      // Clear the active thread so the poll path stops re-fetching it.
      void invoke('set_active_thread', { rootEventId: null });
    };
  });
</script>

<aside class="thread-panel" aria-label="Thread">
  <header class="thread-header" data-tauri-drag-region>
    <button class="thread-close" type="button" onclick={onclose} aria-label="Close thread">
      ‹ Back
    </button>
    <h2 class="thread-title">{sanitizeVisibleIdentifiers(title)}</h2>
  </header>

  <div class="thread-root">
    <Conversation
      messages={root ? [root] : []}
      {showAuthors}
      composer={false}
      loading={loading && !root}
      error={!root && loadError ? loadError : null}
      onsend={async () => {}}
    />
    <span class="thread-root-label">
      {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
    </span>
  </div>

  <div class="thread-body">
    <Conversation
      messages={replies}
      {showAuthors}
      loading={loading && replies.length === 0}
      error={loadError && replies.length === 0 ? loadError : null}
      {sending}
      {sendError}
      placeholder="Reply in thread…"
      onsend={sendReply}
      reactions={reactionsCtl?.map ?? {}}
      ontogglereaction={reactionsCtl ? reactionsCtl.toggle : undefined}
    >
      {#snippet belowMessages()}
        <AgentThinkingRow entries={thinkingCtl?.entries ?? []} />
      {/snippet}
    </Conversation>
  </div>
</aside>

<style>
  .thread-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    background: var(--surface-panel, var(--pop-bg));
    border-left: 1px solid var(--border, var(--pop-divider));
  }

  .thread-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.875rem 1rem 0.75rem;
    border-bottom: 1px solid var(--border, var(--pop-divider));
    flex-shrink: 0;
  }

  .thread-close {
    border: none;
    background: var(--row-hover, var(--pop-hover));
    color: var(--fg, var(--pop-text));
    font-family: inherit;
    font-size: var(--text-base);
    font-weight: 600;
    padding: 0.25rem 0.625rem;
    border-radius: 7px;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .thread-close:hover {
    background: var(--c-field-bg);
  }

  .thread-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg, var(--pop-text));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Pinned root message at the top of the panel. */
  .thread-root {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    padding: 0;
    border-bottom: 1px solid var(--border, var(--pop-divider));
    background: transparent;
  }

  /* Shared Conversation uses flex:1; keep this pin sized to content, not a nested scroller. */
  .thread-root :global(.dm-thread-wrap),
  .thread-root :global(.dm-thread) {
    flex: none;
    min-height: auto;
    overflow: visible;
  }

  .thread-root-label {
    padding: 0.25rem 1rem 0.5rem;
    border-top: 1px solid var(--border, var(--pop-divider));
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--muted, var(--pop-muted));
    text-transform: none;
  }

  /* The reply list + composer (shared <Conversation/>) flexes to fill. */
  .thread-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
</style>
