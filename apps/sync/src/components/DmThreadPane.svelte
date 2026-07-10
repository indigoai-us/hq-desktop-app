<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import Conversation, { type ConversationMessage } from './messaging/Conversation.svelte';
  import { type ReactionEvent, dmScope } from '../lib/reactions';
  import { ReactionController } from '../lib/reactionController.svelte';
  import { shouldAppendInbound } from '../lib/dmThread';

  // Wire type for a DM event — same fields as notificationGroups.DmEvent /
  // Item.dm (structural match; keep fields in lockstep). Exported so shells
  // can import the type with the pane (mirrors ConversationMessage).
  export interface DmEvent {
    eventId: string;
    fromPersonUid: string;
    fromEmail: string;
    fromDisplayName: string;
    body: string;
    details?: string | null;
    prompt?: string | null;
    createdAt: string;
  }

  // Main thread + composer for dm-detail (and when a DM is selected from the
  // quick-window side pane). Behavior-identical extract from DmDetail: thread
  // load, live append, reactions, send reply. Reloads when `event` changes.

  interface Props {
    event: DmEvent;
  }

  let { event }: Props = $props();

  // One rendered message in the thread. `direction` is relative to the signed-in
  // user: "out" = I sent it, "in" = the other person sent it.
  interface ThreadMessage extends ConversationMessage {
    fromEmail: string;
  }

  interface ThreadResponse {
    messages: ThreadMessage[];
    nextCursor?: string | null;
  }

  let messages = $state<ThreadMessage[]>([]);
  let loadingThread = $state(false);
  let threadError = $state<string | null>(null);

  let sending = $state(false);
  let sendError = $state<string | null>(null);

  // Reactions (US-025) for this DM conversation. Created when the DM event
  // arrives (its peer is the scope), kept in step with the visible messages.
  let reactionsCtl = $state<ReactionController | null>(null);

  $effect(() => {
    const peer = event.fromPersonUid;
    if (!peer) {
      reactionsCtl?.dispose();
      reactionsCtl = null;
      return;
    }
    const controller = new ReactionController(dmScope(peer));
    reactionsCtl = controller;
    return () => controller.dispose();
  });

  $effect(() => {
    const controller = reactionsCtl;
    if (!controller) return;
    const ids = messages
      .filter((m) => !m.eventId.startsWith('local-'))
      .map((m) => m.eventId);
    void controller.setMessages(ids);
  });

  /**
   * Merge the server thread (newest-first) into chronological order and ensure
   * the live DM that opened the window is present — the conversation mirror is
   * written best-effort server-side, so the just-arrived DM may not be in the
   * thread response yet. Dedupe by eventId.
   */
  function buildThread(serverMsgs: ThreadMessage[], live: DmEvent): ThreadMessage[] {
    const chrono = [...serverMsgs].reverse();
    if (!chrono.some((m) => m.eventId === live.eventId)) {
      chrono.push({
        eventId: live.eventId,
        fromPersonUid: live.fromPersonUid,
        fromEmail: live.fromEmail,
        fromDisplayName: live.fromDisplayName,
        body: live.body,
        details: live.details ?? null,
        prompt: live.prompt ?? null,
        createdAt: live.createdAt,
        direction: 'in',
      });
    }
    return chrono;
  }

  async function loadThread(forEvent: DmEvent): Promise<void> {
    loadingThread = true;
    threadError = null;
    try {
      const resp = await invoke<ThreadResponse>('fetch_dm_thread', {
        withPersonUid: forEvent.fromPersonUid,
      });
      messages = buildThread(resp.messages ?? [], forEvent);
    } catch (err) {
      // Non-fatal: still show the single live message + composer.
      threadError = typeof err === 'string' ? err : 'Could not load earlier messages';
      messages = buildThread([], forEvent);
      console.error('dm-thread-pane: fetch_dm_thread failed', err);
    } finally {
      loadingThread = false;
    }
  }

  /**
   * Append a freshly-arrived inbound DM to the open thread when it's from the
   * peer this pane is scoped to. Deduped by eventId. DMs from other peers are
   * ignored — this pane is a single conversation.
   */
  function appendInbound(dm: DmEvent): void {
    if (!shouldAppendInbound(messages, dm, event.fromPersonUid)) return;
    messages = [
      ...messages,
      {
        eventId: dm.eventId,
        fromPersonUid: dm.fromPersonUid,
        fromEmail: dm.fromEmail,
        fromDisplayName: dm.fromDisplayName,
        body: dm.body,
        details: dm.details ?? null,
        prompt: dm.prompt ?? null,
        createdAt: dm.createdAt,
        direction: 'in',
      },
    ];
  }

  async function sendReply(text: string): Promise<void> {
    if (!text || sending) return;
    sending = true;
    sendError = null;
    try {
      await invoke('send_dm', { toPersonUid: event.fromPersonUid, body: text });
      // Optimistically append the sent message so the thread updates instantly;
      // the durable copy lands in the mirror and shows on the next open.
      messages = [
        ...messages,
        {
          eventId: `local-${messages.length}-${text.length}`,
          fromPersonUid: 'me',
          fromEmail: '',
          fromDisplayName: 'You',
          body: text,
          details: null,
          prompt: null,
          createdAt: new Date().toISOString(),
          direction: 'out',
        },
      ];
    } catch (err) {
      sendError = typeof err === 'string' ? err : 'Failed to send reply';
      console.error('dm-thread-pane: send_dm failed', err);
    } finally {
      sending = false;
    }
  }

  // Reload thread when the selected DM changes (side-pane swap).
  $effect(() => {
    const forEvent = event;
    void loadThread(forEvent);
  });

  $effect(() => {
    // Disposed flag: side-pane swaps can unmount this pane before the async
    // listen() registrations resolve — a late unlisten must run immediately or
    // the handler leaks for the window's lifetime.
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };

    // Live inbound: a new DM from the peer being viewed lands in the thread
    // without a reopen. The poll/MQTT path broadcasts every freshly-polled DM
    // as `dm:new-events` (a batch); we filter to this conversation's peer.
    listen<DmEvent[]>('dm:new-events', (e) => {
      for (const dm of e.payload ?? []) appendInbound(dm);
    }).then(track);

    // Live reaction reconcile for this DM (US-025).
    listen<ReactionEvent>('message:reaction', (e) => {
      reactionsCtl?.applyEvent(e.payload);
    }).then(track);

    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  });
</script>

<Conversation
  {messages}
  showAuthors={false}
  loading={loadingThread}
  error={threadError}
  {sending}
  {sendError}
  placeholder={`Reply to ${event.fromDisplayName}…`}
  onsend={sendReply}
  reactions={reactionsCtl?.map ?? {}}
  ontogglereaction={reactionsCtl ? reactionsCtl.toggle : undefined}
/>
