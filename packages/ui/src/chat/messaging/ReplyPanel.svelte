<script lang="ts">
  /**
   * ReplyPanel — Slack-style reply column (port of hq-desktop-app ThreadPanel).
   * Chrome says “Thread” (Slack). Overlay vs third-column lives in the
   * host (ConversationView / DesktopApp).
   *
   * ZERO extra fetch after send — cache-first; the host must not re-GET the
   * whole reply thread on ack (hq-work-desktop-io-off-main-thread).
   */
  import { untrack } from "svelte";

  import IdentityMark from "./IdentityMark.svelte";
  import MessageAttachments from "./MessageAttachments.svelte";
  import PromptAttachment from "./PromptAttachment.svelte";
  import ReactionBar from "./ReactionBar.svelte";
  import { parseMessageAttachments } from "./channelMessageModels";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import {
    CHAT_ATTACHMENT_ACCEPT,
    MAX_CHAT_ATTACHMENTS,
    isAllowedChatAttachment,
    type ChatAttachmentWire,
  } from "./chat-attachments";
  import {
    toggleReaction,
    type ReactionAggregate,
    type ReactionMap,
  } from "./reactions";
  import { renderMessageBodyMarkdown } from "../../common/messageMarkdown.js";
  import type {
    ChatWakeBus,
    ConversationApi,
    ConversationMessageWire,
    ReplyThreadScope,
  } from "../chat-api";
  import { subscribeReplyNew } from "../chat-api";

  export interface ReplyPreview {
    author: string;
    at: string;
  }

  interface LocalReply extends ConversationMessageWire {
    sendStatus?: "sending" | "failed";
  }

  interface Props {
    api: ConversationApi;
    rootEventId: string;
    scope: ReplyThreadScope;
    channelId?: string | null;
    withPersonUid?: string | null;
    /** Timeline root for instant pin while GET /threads is in flight. */
    seedRoot?: ConversationMessageWire | null;
    /** Host wake bus. Matching `reply:new` re-fetches; other roots are ignored. */
    wakes?: ChatWakeBus | null;
    reactions?: ReactionMap;
    ontogglereaction?: (messageId: string, emoji: string) => void;
    /** Signed-in display name so optimistic replies are not labelled "You". */
    selfDisplayName?: string | null;
    /**
     * Host-owned upload seam: uploads to the vault and returns wire
     * attachments. Absent = the attach affordance is hidden (web
     * ConversationView has no upload path yet).
     */
    onuploadfiles?: (files: File[]) => Promise<ChatAttachmentWire[]>;
    /** Presign a vault GET so reply image thumbs can render bytes. */
    onpresign?: (
      companyUid: string,
      vaultPath: string,
    ) => Promise<string | null>;
    /** Open the host attachment viewer (optional — thumbs render regardless). */
    onopenattachment?: (item: FileAttachmentModel) => void;
    onclose: () => void;
    onreplycount?: (
      rootEventId: string,
      replyCount: number,
      preview?: ReplyPreview | null,
    ) => void;
    /** personUid → presigned avatar URL for real profile photos. */
    avatarByUid?: Record<string, string>;
  }

  let {
    api,
    rootEventId,
    scope,
    channelId = null,
    withPersonUid = null,
    seedRoot = null,
    wakes = null,
    reactions = {},
    ontogglereaction,
    selfDisplayName = null,
    onuploadfiles = undefined,
    onpresign = undefined,
    onopenattachment = undefined,
    onclose,
    onreplycount,
    avatarByUid = {},
  }: Props = $props();

  /** Real avatar for a thread message's author, when known. */
  function replyAvatarFor(
    msg: { fromPersonUid?: string | null } | null | undefined,
  ): string | null {
    const uid = (msg?.fromPersonUid ?? "").trim();
    return (uid && avatarByUid[uid]) || null;
  }

  let root = $state<ConversationMessageWire | null>(null);
  let replies = $state<LocalReply[]>([]);
  let replyCount = $state(0);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let sending = $state(false);
  let draft = $state("");
  let loadGeneration = 0;
  let localSeq = 0;
  let seenIds = $state(new Set<string>());
  let localReactions = $state<ReactionMap>({});
  let pendingFiles = $state<File[]>([]);
  let attachError = $state<string | null>(null);
  let pasteCounter = 0;

  $effect(() => {
    localReactions = { ...reactions };
  });

  function messageAuthor(msg: ConversationMessageWire): string {
    return msg.fromDisplayName?.trim() || msg.fromEmail || "Unknown";
  }

  function isAgent(msg: ConversationMessageWire): boolean {
    return (
      (msg.fromPersonUid ?? "").startsWith("agt_") ||
      /agent/i.test(messageAuthor(msg))
    );
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function previewFrom(list: ConversationMessageWire[]): ReplyPreview | null {
    const last = list[list.length - 1];
    if (!last) return null;
    const author = messageAuthor(last);
    const at = last.createdAt?.trim() ?? "";
    if (!author || !at) return null;
    return { author, at };
  }

  function sortOldestFirst(
    list: ConversationMessageWire[],
  ): ConversationMessageWire[] {
    return [...list].sort((a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
      return aTime - bTime;
    });
  }

  function reactionsFor(id: string): ReactionAggregate[] {
    return localReactions[id] ?? [];
  }

  function toggle(messageId: string, emoji: string): void {
    localReactions = {
      ...localReactions,
      [messageId]: toggleReaction(localReactions[messageId], emoji),
    };
    ontogglereaction?.(messageId, emoji);
  }

  function emitCount(count: number, list: ConversationMessageWire[]): void {
    replyCount = count;
    onreplycount?.(rootEventId, count, previewFrom(list));
  }

  async function load(): Promise<void> {
    const generation = ++loadGeneration;
    const requested = rootEventId;
    loading = replies.length === 0;
    loadError = null;
    try {
      const view = await api.fetchReplyThread({
        scope,
        rootEventId,
        ...(scope === "channel" && channelId ? { channelId } : {}),
        ...(scope === "dm" && withPersonUid ? { withPersonUid } : {}),
      });
      if (generation !== loadGeneration || rootEventId !== requested) return;
      root = view.root ?? seedRoot ?? null;
      const ordered = sortOldestFirst(view.replies ?? []);
      seenIds = new Set(ordered.map((row) => row.eventId));
      const pending = replies.filter(
        (row) =>
          row.eventId.startsWith("local-") &&
          (row.sendStatus === "sending" || row.sendStatus === "failed"),
      );
      replies = [...ordered, ...pending];
      emitCount(view.replyCount ?? ordered.length, ordered);
    } catch (err) {
      if (generation !== loadGeneration || rootEventId !== requested) return;
      loadError =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Could not load replies";
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function addPendingFiles(list: FileList | File[]): void {
    const next = [...pendingFiles];
    const errors: string[] = [];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_CHAT_ATTACHMENTS) {
        errors.push(`You can attach up to ${MAX_CHAT_ATTACHMENTS} files`);
        break;
      }
      const reason = isAllowedChatAttachment(file);
      if (reason) {
        errors.push(reason);
        continue;
      }
      if (
        next.some((row) => row.name === file.name && row.size === file.size)
      ) {
        continue;
      }
      next.push(file);
    }
    pendingFiles = next;
    attachError = errors[0] ?? null;
  }

  function removePendingFile(index: number): void {
    pendingFiles = pendingFiles.filter((_, i) => i !== index);
    attachError = null;
  }

  /** Pasted screenshots all arrive named "image.png" — make each unique. */
  function namePastedFile(file: File): File {
    if (!file.type.startsWith("image/") || file.name !== "image.png") {
      return file;
    }
    pasteCounter += 1;
    const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return new File([file], `pasted-${stamp}-${pasteCounter}.${ext}`, {
      type: file.type,
    });
  }

  function onComposerPaste(e: ClipboardEvent): void {
    if (!onuploadfiles) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addPendingFiles(files.map(namePastedFile));
  }

  async function resolveAttachmentUrl(
    item: FileAttachmentModel,
  ): Promise<string | null> {
    if (item.previewUrl) return item.previewUrl;
    if (!onpresign || !item.companyUid || !item.vaultPath) return null;
    return onpresign(item.companyUid, item.vaultPath);
  }

  async function deliver(
    body: string,
    attachments?: ChatAttachmentWire[],
  ): Promise<void> {
    await api.sendReply({
      scope,
      rootEventId,
      body,
      ...(scope === "channel" && channelId ? { channelId } : {}),
      ...(scope === "dm" && withPersonUid ? { withPersonUid } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  }

  async function send(body: string): Promise<void> {
    const text = body.trim();
    if ((!text && pendingFiles.length === 0) || sending) return;
    sending = true;
    let attachments: ChatAttachmentWire[] | undefined;
    if (pendingFiles.length > 0 && onuploadfiles) {
      try {
        attachments = await onuploadfiles([...pendingFiles]);
      } catch (err) {
        attachError =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : "Could not upload the file";
        sending = false;
        return;
      }
    }
    const localId = `local-${rootEventId}-${++localSeq}`;
    const optimistic: LocalReply = {
      eventId: localId,
      fromDisplayName: selfDisplayName?.trim() || "You",
      body: text,
      createdAt: new Date().toISOString(),
      direction: "out",
      rootEventId,
      sendStatus: "sending",
      ...(attachments ? { attachments } : {}),
    };
    seenIds.add(localId);
    replies = [...replies, optimistic];
    draft = "";
    pendingFiles = [];
    attachError = null;
    try {
      await deliver(text, attachments);
      replies = replies.map((row) =>
        row.eventId === localId ? { ...row, sendStatus: undefined } : row,
      );
      emitCount(replyCount + 1, replies);
    } catch {
      replies = replies.map((row) =>
        row.eventId === localId ? { ...row, sendStatus: "failed" } : row,
      );
    } finally {
      sending = false;
    }
  }

  async function retrySend(eventId: string): Promise<void> {
    const failed = replies.find(
      (row) => row.eventId === eventId && row.sendStatus === "failed",
    );
    if (!failed || sending) return;
    sending = true;
    replies = replies.map((row) =>
      row.eventId === eventId ? { ...row, sendStatus: "sending" } : row,
    );
    try {
      await deliver(
        failed.body ?? "",
        (failed.attachments ?? undefined) as ChatAttachmentWire[] | undefined,
      );
      replies = replies.map((row) =>
        row.eventId === eventId ? { ...row, sendStatus: undefined } : row,
      );
      emitCount(replyCount + 1, replies);
    } catch {
      replies = replies.map((row) =>
        row.eventId === eventId ? { ...row, sendStatus: "failed" } : row,
      );
    } finally {
      sending = false;
    }
  }

  function onComposerKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  $effect(() => {
    void rootEventId;
    void scope;
    void channelId;
    void withPersonUid;
    untrack(() => {
      root = seedRoot ?? null;
      replies = [];
      replyCount = 0;
      seenIds = new Set();
      void load();
    });
  });

  $effect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onclose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onReplyNew(root: string): void {
    if (root !== rootEventId) return;
    void load();
  }

  $effect(() => {
    if (wakes) {
      return wakes.on("reply:new", (payload) => {
        onReplyNew(payload.rootEventId);
      });
    }
    return subscribeReplyNew((payload) => {
      onReplyNew(payload.rootEventId);
    });
  });
</script>

<aside
  class="reply-panel"
  aria-label="Thread"
  data-testid="reply-panel"
  data-root-event-id={rootEventId}
>
  <header class="reply-header">
    <h2 class="reply-title" data-testid="reply-panel-title">Thread</h2>
    <button
      class="reply-close"
      type="button"
      data-testid="reply-panel-close"
      aria-label="Close"
      title="Close"
      onclick={onclose}
    >
      ×
    </button>
  </header>

  <div class="reply-root" data-testid="reply-panel-root">
    {#if root}
      <span class="reply-avatar" aria-hidden="true">
        <IdentityMark
          kind={isAgent(root) ? "agent" : "person"}
          label={messageAuthor(root)}
          avatarUrl={replyAvatarFor(root)}
          size="regular"
        />
      </span>
      <div class="reply-col">
        <div class="reply-meta">
          <span class="reply-root-author">{messageAuthor(root)}</span>
          <span class="reply-time">{formatTime(root.createdAt)}</span>
        </div>
        <div class="reply-root-body">
          {#if root.body?.trim()}
            <div class="reply-md">
              {@html renderMessageBodyMarkdown(root.body ?? "")}
            </div>
          {/if}
          {#if root.details?.trim()}
            <PromptAttachment
              kind="details"
              text={root.details}
              eventId={root.eventId}
            />
          {/if}
          {#if root.prompt?.trim()}
            <PromptAttachment
              kind="prompt"
              text={root.prompt}
              eventId={root.eventId}
            />
          {/if}
          <MessageAttachments
            attachments={parseMessageAttachments(root)}
            onopen={onopenattachment}
            resolveUrl={resolveAttachmentUrl}
          />
        </div>
        <ReactionBar
          messageId={root.eventId}
          reactions={reactionsFor(root.eventId)}
          ontoggle={toggle}
          compact
        />
        <span class="reply-root-label">
          {replyCount}
          {replyCount === 1 ? "reply" : "replies"}
        </span>
      </div>
    {:else if loading}
      <p class="reply-status" role="status">Loading replies…</p>
    {:else if loadError}
      <p class="reply-status reply-error" role="alert">{loadError}</p>
    {/if}
  </div>

  <div class="reply-body">
    <div class="reply-list" data-testid="reply-panel-list">
      {#if loading && replies.length === 0 && root}
        <p class="reply-status" role="status">Loading replies…</p>
      {:else if loadError && replies.length === 0 && root}
        <p class="reply-status reply-error" role="alert">{loadError}</p>
      {:else if replies.length === 0}
        <p class="reply-status" data-testid="reply-panel-empty" role="status">
          No replies yet
        </p>
      {:else}
        {#each replies as msg (msg.eventId)}
          <div
            class="reply-row"
            data-testid="reply-panel-message"
            data-event-id={msg.eventId}
            data-send-status={msg.sendStatus ?? ""}
          >
            <span class="reply-avatar" aria-hidden="true">
              <IdentityMark
                kind={isAgent(msg) ? "agent" : "person"}
                label={messageAuthor(msg)}
                avatarUrl={replyAvatarFor(msg)}
                size="regular"
              />
            </span>
            <div class="reply-col">
              <div class="reply-meta">
                <span class="reply-author">{messageAuthor(msg)}</span>
                <span class="reply-time">{formatTime(msg.createdAt)}</span>
              </div>
              {#if msg.body?.trim()}
                <div class="reply-md">
                  {@html renderMessageBodyMarkdown(msg.body ?? "")}
                </div>
              {/if}
              <MessageAttachments
                attachments={parseMessageAttachments(msg)}
                onopen={onopenattachment}
                resolveUrl={resolveAttachmentUrl}
              />
              {#if !msg.eventId.startsWith("local-")}
                <ReactionBar
                  messageId={msg.eventId}
                  reactions={reactionsFor(msg.eventId)}
                  ontoggle={toggle}
                  compact
                />
              {/if}
              {#if msg.sendStatus === "sending"}
                <span class="reply-send-state" role="status">Sending…</span>
              {:else if msg.sendStatus === "failed"}
                <button
                  type="button"
                  class="reply-send-state failed"
                  data-testid="reply-panel-retry"
                  onclick={() => void retrySend(msg.eventId)}
                >
                  Failed — tap to retry
                </button>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="reply-composer">
      {#if pendingFiles.length > 0 || attachError}
        <div class="reply-pending" data-testid="reply-panel-pending">
          {#each pendingFiles as file, i (file.name + file.size + i)}
            <span class="reply-chip">
              <span class="reply-chip-name">{file.name}</span>
              <button
                type="button"
                class="reply-chip-remove"
                aria-label={`Remove ${file.name}`}
                onclick={() => removePendingFile(i)}
              >
                ×
              </button>
            </span>
          {/each}
          {#if attachError}
            <span class="reply-attach-error">{attachError}</span>
          {/if}
        </div>
      {/if}
      <textarea
        class="reply-input"
        rows="2"
        placeholder="Reply…"
        aria-label="Reply"
        data-testid="reply-panel-composer"
        bind:value={draft}
        onkeydown={onComposerKey}
        onpaste={onComposerPaste}
      ></textarea>
      <div class="reply-composer-footer">
        {#if onuploadfiles}
          <label
            class="reply-attach"
            title="Attach a file"
            data-testid="reply-panel-attach"
          >
            <input
              type="file"
              class="reply-file-input"
              accept={CHAT_ATTACHMENT_ACCEPT}
              multiple
              data-testid="reply-panel-attach-input"
              aria-label="Attach a file"
              onchange={(e) => {
                const input = e.currentTarget;
                if (input.files) addPendingFiles(input.files);
                input.value = "";
              }}
            />
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M13.2 8.2 8.05 13.35a3.25 3.25 0 0 1-4.6-4.6l5.9-5.9a2.15 2.15 0 1 1 3.04 3.04L6.5 11.7a1 1 0 1 1-1.42-1.42l5.15-5.15"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </label>
        {/if}
        <button
          type="button"
          class="reply-send"
          data-testid="reply-panel-send"
          disabled={sending || (!draft.trim() && pendingFiles.length === 0)}
          aria-busy={sending}
          aria-label="Send"
          title="Send"
          onclick={() => void send(draft)}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M2.2 7.35 13.4 2.4a.55.55 0 0 1 .72.72L9.18 14.3a.55.55 0 0 1-1.02.05L6.4 9.6 2.15 8.2a.55.55 0 0 1 .05-1.05Z"
            />
          </svg>
        </button>
      </div>
    </div>
  </div>
</aside>

<style>
  .reply-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    background: var(--surface-panel, var(--v4-ground, #161618));
    border-left: 1px solid var(--line, var(--border, rgba(255, 255, 255, 0.12)));
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  .reply-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
    flex-shrink: 0;
  }

  .reply-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 20px;
    font-weight: 400;
    line-height: 1;
    cursor: pointer;
  }

  .reply-close:hover,
  .reply-close:focus-visible {
    background: var(--hover, color-mix(in srgb, var(--t1) 6%, transparent));
    outline: none;
  }

  .reply-root {
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 8px;
    padding: 12px 16px 16px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  }

  .reply-root-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .reply-time {
    color: var(--t3);
    font-size: 11px;
  }

  .reply-root-author,
  .reply-author {
    font-size: 13px;
    font-weight: 700;
    color: var(--t1);
  }

  .reply-time {
    color: var(--t3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .reply-root-body,
  .reply-md {
    --message-markdown-text: var(--t2, var(--fg, #e8e8e8));
    --message-markdown-muted: var(--t3, #a0a0a0);
    min-width: 0;
    margin: 0;
    /* Match the sidebar/timeline 13px text size. */
    font-size: 13px;
    line-height: 1.5;
    color: var(--t1, var(--message-markdown-text));
    overflow-wrap: anywhere;
  }

  .reply-root-label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--t3);
    text-transform: uppercase;
  }

  .reply-status {
    margin: 0;
    font-size: 13px;
    color: var(--t3);
  }

  .reply-error {
    color: var(--warn-ink, #b45309);
  }

  .reply-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .reply-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .reply-row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 4px 4px;
    border-radius: 6px;
  }

  .reply-row:hover {
    background: color-mix(in srgb, var(--t1) 4%, transparent);
  }

  .reply-col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .reply-meta {
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
  }

  .reply-send-state {
    display: inline-block;
    margin-top: 2px;
    color: var(--t3);
    font-size: 11px;
    font-weight: 400;
  }

  .reply-send-state.failed {
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    background: transparent;
    color: var(--warn-ink, #b45309);
    font: inherit;
    font-size: 11px;
    font-weight: 400;
    cursor: pointer;
  }

  .reply-pending {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .reply-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 200px;
    padding: 4px 8px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 999px;
    background: var(--sel, rgba(255, 255, 255, 0.06));
    font-size: 12px;
  }

  .reply-chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-chip-remove {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }

  .reply-attach-error {
    /* Soft status — never alarm red (Indigo / HQ anti-pattern). */
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 12px;
  }

  .reply-attach {
    margin-right: auto;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: var(--t3, rgba(255, 255, 255, 0.4));
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .reply-attach:hover,
  .reply-attach:focus-within {
    background: var(--hover, color-mix(in srgb, var(--t1) 6%, transparent));
    color: var(--t1);
  }

  .reply-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* Mirrors the main composer (.dm-reply in ChannelConversation) so threaded
     replies get the same send box: raised 10px frame, focus ring on the frame,
     tools bottom-left, solid icon send bottom-right. */
  .reply-composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
    margin: 0 12px 16px;
    padding: 12px 8px 8px 14px;
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 10px;
    background: var(--raised, var(--pop-hover));
    transition: border-color 0.12s;
  }

  .reply-composer:focus-within {
    border-color: var(--border-active, var(--c-field-border));
  }

  .reply-input {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    resize: none;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--t1, var(--pop-text));
    font: 400 13px/1.45 var(--font-ui, inherit);
    caret-color: var(--t1, #f4f4f5);
    box-sizing: border-box;
  }

  .reply-input:focus {
    outline: none;
  }

  .reply-composer-footer {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .reply-send {
    display: grid;
    place-items: center;
    margin-left: auto;
    width: 28px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: #c9d6e4;
    color: #101014;
    cursor: pointer;
    transition:
      opacity 0.15s,
      transform 0.1s;
  }

  .reply-send:hover:not(:disabled) {
    opacity: 0.88;
  }

  .reply-send:active:not(:disabled) {
    transform: scale(0.95);
  }

  .reply-send:disabled {
    cursor: default;
    opacity: 0.4;
  }
</style>
