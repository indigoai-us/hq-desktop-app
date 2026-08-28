<script lang="ts">
  /**
   * Minimal conversation view (US-007) — the channel/DM surface the chat
   * sidebar targets. A faithful reduction of the desktop-alt
   * MessagesShell/ChannelView pair: windowed newest-first history from REST
   * (rendered oldest → newest), generation-guarded loads, optimistic sends
   * with per-row failure + retry, and wake-driven refresh (wakes are advisory
   * only — every wake triggers a REST re-fetch, never a payload apply).
   *
   * Threads, reactions, rosters, board/files tabs arrive with later waves.
   */
  import type { ConversationRow } from "./sidebar-model";
  import type {
    ChatWakeBus,
    ConversationApi,
    ConversationMessageWire,
  } from "./chat-api";
  import {
    bumpRootReplyCount,
    replyNewMatchesConversation,
    replyScopeForRow,
  } from "./chat-api";
  import { untrack } from "svelte";
  import { initialsFor } from "./sidebar-model";
  import {
    collectTimelineRoots,
    isReplyMessage,
    TIMELINE_ROOT_PAGE_SIZE,
  } from "./live-messages";
  import ReplyPanel, { type ReplyPreview } from "./messaging/ReplyPanel.svelte";
  import { REPLY_OVERLAY_MAX_PX } from "./reply-layout";
  import "./tokens.css";
  import "./chat-tokens.css";

  interface Props {
    /** Platform backend seam (web: REST via the platform adapter). */
    api: ConversationApi;
    /** Wake events (web: bridged from the MeshClient). */
    wakes?: ChatWakeBus | null;
    /** The selected sidebar row (`ch:…` channel/group or `dm:…`). */
    row: ConversationRow;
  }

  let { api, wakes = null, row }: Props = $props();

  interface MessageRow {
    eventId: string;
    fromDisplayName: string;
    body: string;
    createdAt: string;
    direction: "in" | "out";
    sendStatus?: "sending" | "failed";
    rootEventId?: string | null;
    replyCount?: number;
  }

  /** Windowed timeline: newest window only; scroll-back pages via cursor. */
  const PAGE_SIZE = TIMELINE_ROOT_PAGE_SIZE;

  let messages = $state<MessageRow[]>([]);
  let loading = $state(false);
  let loadingOlder = $state(false);
  let nextCursor = $state<string | null>(null);
  let threadError = $state<string | null>(null);
  let sending = $state(false);
  let draft = $state("");
  let loadGeneration = 0;
  let localSendSeq = 0;
  let scroller = $state<HTMLDivElement | null>(null);
  let openReplyRootId = $state<string | null>(null);
  let replyPreviewByRoot = $state<Record<string, ReplyPreview>>({});
  let narrowViewport = $state(false);

  function mapWireMessage(wire: ConversationMessageWire): MessageRow {
    return {
      eventId: wire.eventId,
      fromDisplayName:
        wire.fromDisplayName?.trim() || wire.fromEmail || "Unknown",
      body: wire.body ?? "",
      createdAt: wire.createdAt,
      direction: wire.direction === "out" ? "out" : "in",
      rootEventId: wire.rootEventId,
      replyCount: wire.replyCount,
    };
  }

  /** Server returns newest-first; render chronologically (oldest → newest). */
  function toRenderOrder(page: MessageRow[]): MessageRow[] {
    return [...page].reverse();
  }

  async function fetchWirePage(cursor: string | null): Promise<{
    messages: ConversationMessageWire[];
    nextCursor: string | null;
  }> {
    if (row.kind === "dm" && row.personUid) {
      const resp = await api.fetchDmThread({
        withPersonUid: row.personUid,
        limit: PAGE_SIZE,
      });
      return {
        messages: resp.messages ?? [],
        // DM paging arrives with a later wave; newest window only.
        nextCursor: null,
      };
    }
    if (row.channelId) {
      const detail = await api.fetchChannel({
        channelId: row.channelId,
        limit: PAGE_SIZE,
        cursor,
      });
      return {
        messages: detail.messages ?? [],
        nextCursor: detail.nextCursor ?? null,
      };
    }
    return { messages: [], nextCursor: null };
  }

  async function loadRoots(cursor: string | null): Promise<{
    page: MessageRow[];
    nextCursor: string | null;
  }> {
    const { roots, nextCursor: newer } = await collectTimelineRoots({
      fetchPage: fetchWirePage,
      pageSize: PAGE_SIZE,
      initialCursor: cursor,
    });
    return {
      page: roots.filter((wire) => !isReplyMessage(wire)).map(mapWireMessage),
      nextCursor: newer,
    };
  }

  async function load(): Promise<void> {
    const requestedId = row.id;
    const generation = ++loadGeneration;
    loading = messages.length === 0;
    threadError = null;
    try {
      const { page, nextCursor: cursor } = await loadRoots(null);
      if (generation !== loadGeneration || row.id !== requestedId) return;
      // Preserve in-flight optimistic rows so a live refresh never silently
      // drops an unacked send (desktop ChannelView semantics).
      const optimistic = messages.filter(
        (m) =>
          m.eventId.startsWith("local-send-") &&
          (m.sendStatus === "sending" || m.sendStatus === "failed"),
      );
      messages = [...toRenderOrder(page), ...optimistic];
      nextCursor = cursor;
    } catch (err) {
      if (generation !== loadGeneration || row.id !== requestedId) return;
      threadError =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Could not load this conversation";
      console.error("conversation-view: load failed", err);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function loadOlder(): Promise<void> {
    const cursor = nextCursor;
    if (!cursor || loadingOlder || loading) return;
    const requestedId = row.id;
    const generation = loadGeneration;
    loadingOlder = true;
    try {
      const { page, nextCursor: newer } = await loadRoots(cursor);
      if (generation !== loadGeneration || row.id !== requestedId) return;
      // Dedupe by eventId in case of cursor overlap, prepend older rows.
      const known = new Set(messages.map((m) => m.eventId));
      const older = toRenderOrder(page).filter((m) => !known.has(m.eventId));
      messages = [...older, ...messages];
      nextCursor = newer;
    } catch (err) {
      console.error("conversation-view: load older failed", err);
    } finally {
      if (generation === loadGeneration && row.id === requestedId) {
        loadingOlder = false;
      }
    }
  }

  async function deliver(body: string): Promise<void> {
    if (row.kind === "dm" && row.personUid) {
      await api.sendDm({ toPersonUid: row.personUid, body });
    } else if (row.channelId) {
      await api.sendChannelMessage({ channelId: row.channelId, body });
    } else {
      throw new Error("No send target for this conversation");
    }
  }

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body || sending) return;
    const requestedId = row.id;
    const clientId = `local-send-${++localSendSeq}`;
    // Optimistic row: on the timeline immediately, patched in place on
    // failure ("Failed — tap to retry") — never dropped.
    messages = [
      ...messages,
      {
        eventId: clientId,
        fromDisplayName: "You",
        body,
        createdAt: new Date().toISOString(),
        direction: "out",
        sendStatus: "sending",
      },
    ];
    draft = "";
    sending = true;
    try {
      await deliver(body);
      if (row.id !== requestedId) return;
      messages = messages.filter((m) => m.eventId !== clientId);
      // Converge on the server timeline (echo carries the real eventId).
      void load();
    } catch (err) {
      console.error("conversation-view: send failed", err);
      messages = messages.map((m) =>
        m.eventId === clientId ? { ...m, sendStatus: "failed" as const } : m,
      );
    } finally {
      sending = false;
    }
  }

  async function retrySend(eventId: string): Promise<void> {
    const failed = messages.find(
      (m) => m.eventId === eventId && m.sendStatus === "failed",
    );
    if (!failed || sending) return;
    messages = messages.map((m) =>
      m.eventId === eventId ? { ...m, sendStatus: "sending" as const } : m,
    );
    sending = true;
    try {
      await deliver(failed.body);
      messages = messages.filter((m) => m.eventId !== eventId);
      void load();
    } catch (err) {
      console.error("conversation-view: retry failed", err);
      messages = messages.map((m) =>
        m.eventId === eventId ? { ...m, sendStatus: "failed" as const } : m,
      );
    } finally {
      sending = false;
    }
  }

  function onComposerKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Load on conversation change (resets the window + errors). The effect must
  // depend ONLY on `row.id`: the reset + load() below both touch `messages`
  // (load reads `messages.length`), so running them tracked would make this
  // effect self-invalidate (`messages = []` mints a fresh array every run) and
  // loop forever. `untrack` scopes the writes/reads out of the dependency set.
  $effect(() => {
    void row.id;
    untrack(() => {
      messages = [];
      nextCursor = null;
      threadError = null;
      void load();
    });
  });

  // Wake-driven refresh: a wake for THIS conversation re-fetches from REST.
  $effect(() => {
    if (!wakes) return;
    const currentId = row.id;
    const unsubs = [
      wakes.on("channel:new-message", ({ channelId }) => {
        if (currentId === `ch:${channelId}`) void load();
      }),
      wakes.on("dm:pair-unreads", (payload) => {
        if (row.kind !== "dm" || !row.personUid) return;
        // Absent-safe: a rollup naming this peer targets us; a rollup without
        // per-pair detail is still a DM wake — re-fetch from REST either way.
        const pairs = payload.pairUnreads;
        const mine =
          !Array.isArray(pairs) ||
          pairs.some((e) => e.withPersonUid === row.personUid);
        if (mine) void load();
      }),
      wakes.on("reply:new", (payload) => {
        if (!replyNewMatchesConversation(payload, row)) return;
        // Open panel on this root re-fetches the thread. Other roots (or a
        // closed panel) still bump the visible “N replies” count. Do not
        // re-GET the conversation and do not invent sidebar unread.
        if (openReplyRootId === payload.rootEventId) return;
        messages = bumpRootReplyCount(messages, payload.rootEventId);
      }),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  });

  // Stick to the bottom as the conversation grows.
  $effect(() => {
    void messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  function timeLabel(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatRelative(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return timeLabel(iso);
  }

  function replyLabel(count: number): string {
    return count === 1 ? "1 reply" : `${count} replies`;
  }

  function openReply(rootEventId: string): void {
    const id = rootEventId.trim();
    if (id) openReplyRootId = id;
  }

  function closeReply(): void {
    openReplyRootId = null;
  }

  function onReplyCount(
    rootEventId: string,
    count: number,
    preview?: ReplyPreview | null,
  ): void {
    messages = messages.map((m) =>
      m.eventId === rootEventId ? { ...m, replyCount: count } : m,
    );
    if (preview) {
      replyPreviewByRoot = { ...replyPreviewByRoot, [rootEventId]: preview };
    }
  }

  const replyScope = $derived(replyScopeForRow(row));
  const seedRoot = $derived.by((): ConversationMessageWire | null => {
    if (!openReplyRootId) return null;
    const row = messages.find((m) => m.eventId === openReplyRootId);
    if (!row) return null;
    return {
      eventId: row.eventId,
      fromDisplayName: row.fromDisplayName,
      body: row.body,
      createdAt: row.createdAt,
      direction: row.direction,
      rootEventId: row.rootEventId,
      replyCount: row.replyCount,
    };
  });

  $effect(() => {
    void row.id;
    untrack(() => {
      openReplyRootId = null;
    });
  });

  $effect(() => {
    const mq =
      typeof window !== "undefined"
        ? window.matchMedia(`(max-width: ${REPLY_OVERLAY_MAX_PX}px)`)
        : null;
    if (!mq) return;
    const apply = () => {
      narrowViewport = mq.matches;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });
</script>

<section
  class="conversation-view chat-shell"
  aria-label={`Conversation with ${row.title}`}
  data-testid="conversation-view"
  data-conversation-id={row.id}
>
  <div class="conversation-stage" data-testid="chat-stage">
    <div class="conversation-main">
      <div
        class="conv-thread"
        bind:this={scroller}
        data-testid="conversation-thread"
      >
        {#if nextCursor}
          <button
            type="button"
            class="conv-older"
            data-testid="conversation-load-older"
            disabled={loadingOlder}
            onclick={() => void loadOlder()}
          >
            {loadingOlder ? "Loading…" : "Show older messages"}
          </button>
        {/if}
        {#if loading && messages.length === 0}
          <div class="conv-status" role="status">Loading conversation…</div>
        {:else if threadError && messages.length === 0}
          <div class="conv-status" role="alert">{threadError}</div>
        {:else if messages.length === 0}
          <div class="conv-status" data-testid="conversation-empty">
            No messages yet — say hi.
          </div>
        {:else}
          {#each messages as m (m.eventId)}
            <div
              class="conv-msg"
              class:out={m.direction === "out"}
              data-testid="conversation-message"
              data-event-id={m.eventId}
              data-reply-count={m.replyCount ?? 0}
            >
              <span class="conv-avatar" aria-hidden="true">
                {initialsFor(m.fromDisplayName)}
              </span>
              <div class="conv-body">
                <div class="conv-head">
                  <span class="conv-from">{m.fromDisplayName}</span>
                  {#if m.createdAt}
                    <time class="conv-ts" datetime={m.createdAt}>
                      {timeLabel(m.createdAt)}
                    </time>
                  {/if}
                </div>
                <p class="conv-text">{m.body}</p>
                <div class="conv-reply-row">
                  <button
                    type="button"
                    class="conv-reply-action"
                    data-testid="message-reply"
                    aria-label="Reply"
                    onclick={() => openReply(m.eventId)}
                  >
                    Reply
                  </button>
                  {#if (m.replyCount ?? 0) > 0}
                    {@const preview = replyPreviewByRoot[m.eventId]}
                    <button
                      type="button"
                      class="conv-replies-count"
                      data-testid="message-replies"
                      aria-label={replyLabel(m.replyCount ?? 0)}
                      onclick={() => openReply(m.eventId)}
                    >
                      {replyLabel(m.replyCount ?? 0)}
                      {#if preview}
                        <span class="conv-replies-preview">
                          {preview.author}
                          {formatRelative(preview.at)}
                        </span>
                      {/if}
                    </button>
                  {/if}
                </div>
                {#if m.sendStatus === "sending"}
                  <span class="conv-send-state" role="status">Sending…</span>
                {:else if m.sendStatus === "failed"}
                  <button
                    type="button"
                    class="conv-send-state failed"
                    data-testid="conversation-retry"
                    onclick={() => void retrySend(m.eventId)}
                  >
                    Failed — tap to retry
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="conv-composer">
        <textarea
          rows="2"
          placeholder={`Message ${row.title}`}
          aria-label={`Message ${row.title}`}
          data-testid="conversation-composer"
          bind:value={draft}
          onkeydown={onComposerKey}
        ></textarea>
        <button
          type="button"
          class="conv-send"
          data-testid="conversation-send"
          disabled={sending || !draft.trim()}
          aria-busy={sending}
          onclick={() => void send()}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
    {#if openReplyRootId && replyScope}
      <div
        class="reply-column"
        class:overlay={narrowViewport}
        data-testid="reply-column"
        data-reply-layout={narrowViewport ? "overlay" : "column"}
      >
        <ReplyPanel
          {api}
          {wakes}
          rootEventId={openReplyRootId}
          scope={replyScope}
          channelId={row.channelId}
          withPersonUid={row.personUid}
          {seedRoot}
          onclose={closeReply}
          onreplycount={onReplyCount}
        />
      </div>
    {/if}
  </div>
</section>

<style>
  .conversation-view {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    font: 400 13px/1.45 var(--font-ui);
    color: var(--t1);
  }

  .conversation-stage {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .conversation-main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    min-width: 0;
  }

  .reply-column {
    width: 340px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .reply-column.overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(100%, 420px);
    z-index: 5;
    background: var(--v4-ground, #161618);
  }

  .conv-reply-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .conv-reply-action {
    opacity: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t3);
    font: 400 11px/1.3 var(--font-ui);
    cursor: pointer;
  }

  .conv-msg:hover .conv-reply-action,
  .conv-msg:focus-within .conv-reply-action {
    opacity: 1;
  }

  .conv-replies-count {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t2, var(--t1));
    font: 500 11px/1.3 var(--font-ui);
    cursor: pointer;
  }

  .conv-replies-preview {
    color: var(--t3);
    font-weight: 400;
  }

  .conv-thread {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 4px 8px 0;
  }

  .conv-older {
    align-self: center;
    padding: 4px 12px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .conv-older:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .conv-status {
    padding: 16px 4px;
    color: var(--t3);
  }

  .conv-msg {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }

  .conv-msg.out .conv-from {
    color: var(--t1);
  }

  .conv-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font: 600 10px var(--font-ui);
  }

  .conv-body {
    min-width: 0;
    flex: 1 1 auto;
  }

  .conv-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .conv-from {
    color: var(--t2);
    font-size: 12px;
    font-weight: 600;
  }

  .conv-ts {
    color: var(--t3);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .conv-text {
    margin: 2px 0 0;
    color: var(--t1);
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .conv-send-state {
    display: inline-block;
    margin-top: 2px;
    color: var(--t3);
    font-size: 11px;
  }

  .conv-send-state.failed {
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    background: transparent;
    color: var(--warn-ink, #b45309);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .conv-composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex: 0 0 auto;
  }

  .conv-composer textarea {
    flex: 1 1 auto;
    resize: vertical;
    padding: 8px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--raised, transparent);
    color: var(--t1);
    font: inherit;
    box-sizing: border-box;
  }

  .conv-composer textarea:focus {
    outline: none;
    border-color: var(--border-active, var(--line2));
  }

  .conv-send {
    padding: 8px 16px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .conv-send:disabled {
    cursor: default;
    opacity: 0.45;
  }
</style>
