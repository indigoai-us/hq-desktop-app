<script lang="ts">
  /**
   * ChannelConversation — the real channel timeline + composer, ported faithfully
   * from the hq-sync desktop `Conversation.svelte` message-row + reply-composer
   * markup and CSS, and composed from the REAL leaf components
   * (IdentityMark, SystemEventLine, RunCompleteCard, ReactionBar, EmojiPicker).
   *
   * ZERO NETWORK by construction: this component NEVER fetches or connects. The
   * timeline is INJECTED as `messages` (oldest → newest) and reactions as a
   * `reactions` map. There is no onMount fetch, no api seam, no realtime. Sends
   * are optimistic-local and bubble out through `onsend`; reaction toggles bubble
   * through `ontogglereaction`. This is a display component — the host owns data.
   */
  import { onDestroy, untrack, type Snippet } from "svelte";

  import IdentityMark from "./IdentityMark.svelte";
  import SystemEventLine from "./SystemEventLine.svelte";
  import RunCompleteCard from "./RunCompleteCard.svelte";
  import ReactionBar from "./ReactionBar.svelte";
  import EmojiPicker from "./EmojiPicker.svelte";
  import MentionPicker from "./MentionPicker.svelte";
  import PromptAttachment from "./PromptAttachment.svelte";
  import MessageAttachments from "./MessageAttachments.svelte";
  import AttachmentTray from "./AttachmentTray.svelte";
  import {
    parseMessageAttachments,
    systemModelForMessage,
    type FileAttachmentModel,
  } from "./channelMessageModels";
  import { parseWorkSessionEvent } from "./workSessionEvent";
  import WorkMeshActivityRow from "./WorkMeshActivityRow.svelte";
  import {
    CHAT_ATTACHMENT_ACCEPT,
    MAX_CHAT_ATTACHMENTS,
    isImageFile,
    validateChatAttachment,
    type ChatAttachmentValidator,
  } from "./chat-attachments";
  import {
    clipMessageBodyForDisplay,
    isHeavyMessageBody,
    renderMessageBodyMarkdown,
  } from "../../common/messageMarkdown.js";
  import LinkContextMenu from "../../common/LinkContextMenu.svelte";
  import {
    handleLinkActivate,
    type LinkMenuAnchor,
  } from "../../common/external-links.js";
  import {
    toggleReaction,
    type ReactionAggregate,
    type ReactionMap,
  } from "./reactions";
  import { takeNewestWindow, TIMELINE_WINDOW } from "./timeline-window";
  import type { ConversationMessageWire } from "../chat-api";
  import { isReplyMessage } from "../live-messages";
  import {
    activeMentionQuery,
    applyMentionMarkup,
    filterMentionCandidates,
    mentionPayloadTargets,
    mentionSegments,
    mentionTextForTarget,
    mergeMentionTargets,
    replaceActiveMention,
    storedMentionType,
    type MentionTarget,
  } from "../mentions.js";

  interface Props {
    /** Timeline, oldest → newest. Injected — never fetched here. */
    messages: ConversationMessageWire[];
    /** messageId → reaction aggregates. */
    reactions?: ReactionMap;
    /** Composer placeholder (host supplies "Message # … — or type / to run…"). */
    placeholder?: string;
    /** Platform seam for opening an external URL (run-card preview/diff). */
    onopenurl?: (url: string) => void;
    /** Bubbled reaction toggle (host reconciles). */
    ontogglereaction?: (messageId: string, emoji: string) => void;
    /** Bubbled send (host persists). Optional — the composer works standalone. */
    onsend?: (
      body: string,
      mentions: MentionTarget[],
      files?: File[],
    ) => void | Promise<void>;
    /** Presign a vault GET so image thumbs and the tray can render bytes. */
    onpresign?: (
      companyUid: string,
      vaultPath: string,
    ) => Promise<string | null>;
    /** Company/contacts roster for @ completion. Empty = no picker. */
    mentionCandidates?: MentionTarget[];
    /** Open ReplyPanel for this root eventId. */
    onreply?: (rootEventId: string) => void;
    /** Host-owned attachment modal (must render outside this column). */
    onopenattachment?: (
      item: FileAttachmentModel,
      items: FileAttachmentModel[],
    ) => void;
    /** Releases host-created object URLs when an attachment consumer closes. */
    onreleaseurl?: (url: string) => void;
    /** Fallback company for vault presign when a wire attachment omits it. */
    vaultCompanyUid?: string | null;
    /**
     * Last-reply preview from a prior ReplyPanel fetch. Never required from
     * the list API — omit unless the host already knows author + time.
     */
    replyPreviewByRoot?: Readonly<
      Record<
        string,
        {
          author: string;
          at: string;
          authors?: Array<{
            personUid: string;
            displayName: string;
            agent?: boolean;
          }>;
        }
      >
    >;
    /** Root currently open in ReplyPanel (highlight only). */
    activeRootEventId?: string | null;
    /** Host is fetching history — do not flash “No messages yet”. */
    loading?: boolean;
    /** Signed-in display name so optimistic sends are not labelled "You". */
    selfDisplayName?: string | null;
    selfPersonUid?: string | null;
    /** Open a person's profile panel when their name/avatar is clicked. */
    onopenprofile?: (author: {
      personUid: string;
      displayName: string;
    }) => void;
    /** personUid → presigned avatar URL for real profile photos. */
    avatarByUid?: Record<string, string>;
    /** personUid → live roster display name (profile override), preferred over
     *  the name baked into each message at send time. */
    displayNameByUid?: Record<string, string>;
    /** Host-specific attachment limits; desktop uses the shared 25 MB default. */
    attachmentValidator?: ChatAttachmentValidator;
    /**
     * Optional header rendered at the very top of the `.dm-thread` scroller
     * (before empty-state / load-earlier). Used for Slack-style channel intros
     * that scroll away with history.
     */
    header?: Snippet;
    /**
     * Optional status row rendered INSIDE the `.dm-thread` scroller, after the
     * newest message (typing-indicator position). Must live in the scroll flow
     * — `.chat-stage` is a horizontal flexbox, so a sibling of this component
     * would lay out as a second column in the upper-right instead.
     */
    belowMessages?: Snippet;
  }

  let {
    messages,
    reactions = {},
    placeholder = "Reply…",
    onopenurl,
    ontogglereaction,
    onsend,
    onpresign,
    mentionCandidates = [],
    onreply,
    onopenattachment,
    onreleaseurl,
    vaultCompanyUid = null,
    replyPreviewByRoot = {},
    activeRootEventId = null,
    loading = false,
    selfDisplayName = null,
    selfPersonUid = null,
    onopenprofile,
    avatarByUid = {},
    displayNameByUid = {},
    attachmentValidator = validateChatAttachment,
    header,
    belowMessages,
  }: Props = $props();

  /** Real avatar for a message's author, when the roster carried one. */
  function avatarFor(msg: ConversationMessageWire): string | null {
    const uid = (msg.fromPersonUid ?? "").trim();
    return (uid && avatarByUid[uid]) || null;
  }

  /** Emit an author-profile-open when we have a human personUid to resolve. */
  function openAuthorProfile(msg: ConversationMessageWire): void {
    if (!onopenprofile || isAgent(msg)) return;
    const personUid = (msg.fromPersonUid ?? "").trim();
    if (!personUid) return;
    onopenprofile({ personUid, displayName: messageAuthor(msg) });
  }

  /** Delegated open when a clickable @mention span (data-person-uid) is
   *  activated inside a rendered message body. */
  function onMentionActivate(
    event: MouseEvent | KeyboardEvent,
    node: EventTarget | null,
  ): void {
    if (!onopenprofile || !(node instanceof HTMLElement)) return;
    const span = node.closest<HTMLElement>("[data-person-uid]");
    const personUid = span?.dataset.personUid?.trim();
    if (!span || !personUid) return;
    event.preventDefault();
    onopenprofile({
      personUid,
      displayName: span.textContent?.replace(/^@/, "").trim() || personUid,
    });
  }

  let linkMenu = $state<LinkMenuAnchor | null>(null);

  /** Delegated open for markdown/autolinked anchors injected as HTML. */
  function onBodyLinkActivate(event: Event): boolean {
    return handleLinkActivate(event, {
      onopenurl,
      onmenu: (menu) => (linkMenu = menu),
      mode: "message",
    });
  }

  const QUICK_REACT_EMOJI = ["👍", "🎉"] as const;

  // Optimistic local toggles. Merge in a derived — never $effect-write
  // `localReactions` from a read of itself (that loops until the webview dies).
  let localReactions = $state<ReactionMap>({});
  const displayReactions = $derived<ReactionMap>({
    ...reactions,
    ...localReactions,
  });

  // Optimistic local sends appended to the injected timeline (no persistence).
  let localSends = $state<ConversationMessageWire[]>([]);
  let extraOlder = $state(0);
  /** Release blob: previews created for optimistic sends (leak guard). */
  function revokeLocalPreviews(rows: ConversationMessageWire[]): void {
    for (const row of rows) {
      for (const item of row.attachments ?? []) {
        if (item.previewUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
    }
  }

  $effect(() => {
    void messages.at(-1)?.eventId;
    extraOlder = 0;
    // untrack: reading localSends here would make this effect re-run on its
    // own `localSends = []` write (effect depth explosion).
    untrack(() => revokeLocalPreviews(localSends));
    localSends = [];
  });
  const rootMessages = $derived(messages.filter((msg) => !isReplyMessage(msg)));
  const windowed = $derived(
    takeNewestWindow(rootMessages, { extra: extraOlder }),
  );
  /** First eventId wins so the keyed each never receives duplicate keys
   *  (host page + optimistic localSends race). */
  const timeline = $derived.by(() => {
    const seen = new Set<string>();
    const out: ConversationMessageWire[] = [];
    for (const msg of [...windowed.rows, ...localSends]) {
      const id = (msg.eventId ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(msg);
    }
    return out;
  });

  let replyText = $state("");
  let replyInputEl = $state<HTMLTextAreaElement | null>(null);
  let attachInputEl = $state<HTMLInputElement | null>(null);
  let pendingFiles = $state<File[]>([]);
  let attachError = $state<string | null>(null);
  let trayOpen = $state(false);
  let traySelectedId = $state<string | null>(null);
  let composerEmojiOpen = $state(false);
  /** eventId whose full emoji picker is open (message-row "+" trigger). */
  let reactPickerFor = $state<string | null>(null);
  let dragActive = $state(false);
  let dragDepth = 0;
  let pasteCounter = 0;
  let scroller = $state<HTMLDivElement | null>(null);
  /**
   * Scroll ownership: the user wins. `stickToBottom` is the SINGLE gate for all
   * programmatic scrolling. It starts true (land on the newest message at mount
   * and on channel switch — the host remounts this component per channel) and
   * flips false the moment the user scrolls up to read history, after which
   * NOTHING may move their offset — not the host's periodic message refresh,
   * not live arrivals, not a timeline merge.
   */
  let stickToBottom = $state(true);
  /** New rows landed while scrolled up — drives the "jump to latest" pill. */
  let hasUnseenBelow = $state(false);
  /** Within this many px of the bottom still counts as pinned. */
  const STICK_THRESHOLD_PX = 40;
  /** scrollHeight captured immediately before an older-history prepend. */
  let prependAnchorHeight = 0;

  function scrollToBottom(): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  /** Recompute stickiness from the user's actual position on every scroll. */
  function onThreadScroll(): void {
    if (!scroller) return;
    const distance =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottom = distance <= STICK_THRESHOLD_PX;
    if (stickToBottom) hasUnseenBelow = false;
  }

  function jumpToLatest(): void {
    stickToBottom = true;
    hasUnseenBelow = false;
    scrollToBottom();
  }

  /** "Show N earlier" prepends rows; anchor the height so the view holds still. */
  function showEarlier(): void {
    prependAnchorHeight = scroller?.scrollHeight ?? 0;
    extraOlder += TIMELINE_WINDOW;
  }
  let selectedMentions = $state<MentionTarget[]>([]);
  let mentionHighlight = $state(0);

  const conversationAttachments = $derived.by((): FileAttachmentModel[] => {
    const out: FileAttachmentModel[] = [];
    const seen = new Set<string>();
    for (const msg of timeline) {
      for (const item of parseMessageAttachments(msg)) {
        const key = item.id || item.vaultPath;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  });
  function syncComposerFromDom(): void {
    const el = replyInputEl;
    if (!el || el.value === replyText) return;
    replyText = el.value;
  }

  const canSend = $derived(
    (replyText.trim().length > 0 && replyText.trim() !== "/") ||
      pendingFiles.length > 0,
  );
  const showAgentMenu = $derived(replyText.trimStart().startsWith("/"));
  const mentionQuery = $derived(activeMentionQuery(replyText));
  const mentionHits = $derived(
    filterMentionCandidates(mentionCandidates, mentionQuery, selectedMentions),
  );
  const showMentionPicker = $derived(mentionQuery !== null);
  const composerSegments = $derived(
    mentionSegments(replyText, selectedMentions),
  );

  $effect(() => {
    void mentionQuery;
    mentionHighlight = 0;
  });

  function messageAuthor(msg: ConversationMessageWire): string {
    // Prefer the live roster display name (the sender's profile override) over
    // the full name baked into the message at send time.
    const uid = (msg.fromPersonUid ?? "").trim();
    const live = uid ? displayNameByUid[uid]?.trim() : "";
    return live || msg.fromDisplayName?.trim() || msg.fromEmail || "Unknown";
  }

  function storedMentions(msg: ConversationMessageWire): MentionTarget[] {
    return (msg.mentions ?? []).map((row) => ({
      participantUid: row.participantUid,
      participantType: storedMentionType(row),
      displayName: row.displayName,
    }));
  }

  function isAgent(msg: ConversationMessageWire): boolean {
    return (
      (msg.fromPersonUid ?? "").startsWith("agt_") ||
      /agent/i.test(messageAuthor(msg))
    );
  }

  /**
   * Work-mesh events carry `event.by`, which may be a person UID rather than
   * a display name. Resolve it against the live roster map (same source the
   * message rows use); when the actor is the sender, reuse messageAuthor.
   * WorkMeshActivityRow itself falls back to "A teammate" for unresolved
   * raw UIDs, so this never surfaces a UUID.
   */
  /** `event.by` UIDs may be bare Cognito subs while roster keys carry a
   *  `prs_`/`agt_` prefix (or vice versa) — compare on the normalized form. */
  function normalizeParticipantUid(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/^(prs_|agt_)/, "");
  }

  /** Normalized uid → display name, merged from the live roster map and the
   *  channel's mention roster so sub-shaped actors still resolve. */
  const workActorNameByUid = $derived.by(() => {
    const map: Record<string, string> = {};
    for (const candidate of mentionCandidates) {
      const name = candidate.displayName?.trim();
      const uid = normalizeParticipantUid(candidate.participantUid ?? "");
      if (name && uid && !map[uid]) map[uid] = name;
    }
    for (const [uid, name] of Object.entries(displayNameByUid)) {
      const trimmed = name?.trim();
      const key = normalizeParticipantUid(uid);
      if (trimmed && key) map[key] = trimmed;
    }
    return map;
  });

  function resolveWorkActor(
    actor: string,
    msg: ConversationMessageWire,
  ): string {
    const raw = actor.trim();
    if (!raw) return raw;
    const live =
      displayNameByUid[raw]?.trim() ||
      workActorNameByUid[normalizeParticipantUid(raw)];
    if (live) return live;
    const sender = (msg.fromPersonUid ?? "").trim();
    if (
      sender &&
      normalizeParticipantUid(raw) === normalizeParticipantUid(sender)
    ) {
      return messageAuthor(msg);
    }
    return raw;
  }

  function formatTime(iso: string): string {
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
    return formatTime(iso);
  }


  /**
   * Affordance data for a root. Prefers a ReplyPanel-sourced preview (freshest
   * once a thread has been opened) and otherwise derives it from the row
   * itself — `foldReplyMetadata` populates `lastReplyAt` / `replyAuthors` from
   * the reply rows the timeline page already carried, so avatars + the
   * last-reply stamp render on FIRST paint without opening the thread.
   */
  function replyMetaFor(msg: ConversationMessageWire): {
    at: string | null;
    authors: NonNullable<ConversationMessageWire["replyAuthors"]>;
  } {
    const preview = replyPreviewByRoot[msg.eventId];
    const authors = preview?.authors?.length
      ? preview.authors
      : (msg.replyAuthors ?? []);
    return { at: preview?.at ?? msg.lastReplyAt ?? null, authors };
  }

  function replyLabel(count: number): string {
    return count === 1 ? "1 reply" : `${count} replies`;
  }

  function openReply(rootEventId: string): void {
    const id = rootEventId.trim();
    if (id) onreply?.(id);
  }

  function reactionsFor(id: string): ReactionAggregate[] {
    return displayReactions[id] ?? [];
  }

  /** Calendar-day key for the day-divider comparison (absent-safe). */
  function dayKey(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toDateString();
  }

  /** True when this row opens a new calendar day (drives the TODAY divider). */
  function startsNewDay(index: number): boolean {
    if (index === 0) return true;
    return (
      dayKey(timeline[index - 1].createdAt) !==
      dayKey(timeline[index].createdAt)
    );
  }

  /** Divider label — Today / Yesterday / "Aug 15" (the CSS uppercases it). */
  function formatDateSeparator(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  /** Bursts group only within this window; older same-author rows re-header. */
  const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

  /** Stable sender identity — uid first, display name as fallback. */
  function senderKey(msg: ConversationMessageWire): string {
    return (msg.fromPersonUid ?? "").trim() || messageAuthor(msg);
  }

  /** System / run-complete rows are their own headers, never grouped. */
  function isSpecialTimelineRow(msg: ConversationMessageWire): boolean {
    return systemModelForMessage(msg) !== null;
  }

  /**
   * Two adjacent rows share a group when the same sender speaks in the same
   * direction, on the same calendar day, within a 5-minute window. Ported from
   * hq-sync Conversation.svelte `messagesShareGroup` — replaces the old
   * author-name-equality check so a same-author burst > 5 min apart re-shows the
   * author header.
   */
  function messagesShareGroup(
    prev: ConversationMessageWire | undefined,
    cur: ConversationMessageWire | undefined,
  ): boolean {
    if (!prev || !cur) return false;
    if (isSpecialTimelineRow(prev) || isSpecialTimelineRow(cur)) return false;
    if ((prev.direction ?? "in") !== (cur.direction ?? "in")) return false;
    if (senderKey(prev) !== senderKey(cur)) return false;
    if (dayKey(prev.createdAt) !== dayKey(cur.createdAt)) return false;

    const prevTime = new Date(prev.createdAt).getTime();
    const curTime = new Date(cur.createdAt).getTime();
    if (Number.isNaN(prevTime) || Number.isNaN(curTime)) return false;

    const elapsed = curTime - prevTime;
    return elapsed >= 0 && elapsed <= MESSAGE_GROUP_WINDOW_MS;
  }

  function startsGroup(index: number): boolean {
    if (index === 0) return true;
    return !messagesShareGroup(timeline[index - 1], timeline[index]);
  }

  function toggle(messageId: string, emoji: string): void {
    localReactions = {
      ...localReactions,
      [messageId]: toggleReaction(displayReactions[messageId], emoji),
    };
    ontogglereaction?.(messageId, emoji);
  }

  function insertComposerEmoji(emoji: string): void {
    replyText = `${replyText}${emoji}`;
    composerEmojiOpen = false;
    replyInputEl?.focus();
  }

  function applyMention(target: MentionTarget): void {
    replyText = replaceActiveMention(replyText, mentionTextForTarget(target));
    selectedMentions = mergeMentionTargets(selectedMentions, target);
    mentionHighlight = 0;
    replyInputEl?.focus();
  }

  function addPendingFiles(list: FileList | File[]): void {
    const next = [...pendingFiles];
    const errors: string[] = [];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_CHAT_ATTACHMENTS) {
        errors.push(`You can attach up to ${MAX_CHAT_ATTACHMENTS} files`);
        break;
      }
      const error = attachmentValidator(file);
      if (error) {
        errors.push(error.message);
        continue;
      }
      if (
        next.some(
          (existing) =>
            existing.name === file.name && existing.size === file.size,
        )
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

  /**
   * Lazy object URLs for image previews of pending composer files. The
   * $effect below revokes URLs whenever a file leaves pendingFiles (remove,
   * send-clear), and onDestroy revokes whatever is left.
   */
  const pendingPreviewUrls = new Map<File, string>();
  function pendingPreviewUrl(file: File): string {
    let url = pendingPreviewUrls.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      pendingPreviewUrls.set(file, url);
    }
    return url;
  }
  $effect(() => {
    const current = new Set(pendingFiles);
    for (const [file, url] of pendingPreviewUrls) {
      if (!current.has(file)) {
        URL.revokeObjectURL(url);
        pendingPreviewUrls.delete(file);
      }
    }
  });
  onDestroy(() => {
    for (const url of pendingPreviewUrls.values()) URL.revokeObjectURL(url);
    pendingPreviewUrls.clear();
  });

  /**
   * Pasted screenshots arrive as clipboard files all named "image.png" — give
   * each a unique name so the (name, size) dedupe and vault path stay distinct.
   */
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
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addPendingFiles(files.map(namePastedFile));
  }

  function hasDraggedFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function onDragEnter(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dragActive = true;
  }

  function onDragOver(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragActive = false;
  }

  function onDrop(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragActive = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      addPendingFiles(files);
      replyInputEl?.focus();
    }
  }

  /** Soft, human copy for composer failures — never dump raw API codes. */
  function formatComposerSendError(raw: string, hadFiles: boolean): string {
    if (/failed to fetch|networkerror|^load failed$/i.test(raw)) {
      return hadFiles
        ? "Could not upload the file"
        : "Could not send the message";
    }
    if (/CHANNEL_NOT_FOUND|channel not found/i.test(raw)) {
      return "Couldn't send — this channel isn't available right now. Try reopening it.";
    }
    if (/CHANNEL_MENTION_INVITE_FORBIDDEN|mention-invite/i.test(raw)) {
      return "Couldn't send — only the channel owner can mention someone who isn't a member yet.";
    }
    if (
      /MENTION_PARTICIPANT_NOT_FOUND|mentioned participant was not found/i.test(
        raw,
      )
    ) {
      return "Couldn't send — that @mention couldn't be resolved.";
    }
    if (
      /MENTION_PARTICIPANT_NOT_VISIBLE|not active in this company/i.test(raw)
    ) {
      return "Couldn't send — that person isn't active in this company.";
    }
    // Strip machine codes like "[CHANNEL_NOT_FOUND] …" if a human message remains.
    const stripped = raw.replace(/^\[[A-Z0-9_]+\]\s*/i, "").trim();
    if (stripped && stripped.length <= 160 && !/^[A-Z0-9_]+$/.test(stripped)) {
      return stripped.startsWith("Couldn't") || stripped.startsWith("Could not")
        ? stripped
        : `Couldn't send — ${stripped}`;
    }
    return hadFiles
      ? "Could not send the attachment"
      : "Could not send the message";
  }

  function openAttachment(item: FileAttachmentModel): void {
    if (onopenattachment) {
      onopenattachment(item, conversationAttachments);
      return;
    }
    traySelectedId = item.id || item.vaultPath;
    trayOpen = true;
  }

  async function resolveAttachmentUrl(
    item: FileAttachmentModel,
  ): Promise<string | null> {
    if (item.previewUrl) return item.previewUrl;
    const companyUid = item.companyUid || vaultCompanyUid || "";
    if (!onpresign || !companyUid || !item.vaultPath) return null;
    return onpresign(companyUid, item.vaultPath);
  }

  async function send(): Promise<void> {
    syncComposerFromDom();
    const body = replyText.trim();
    if (body === "/") return;
    if (!body && pendingFiles.length === 0) return;
    const mentions = mentionPayloadTargets(selectedMentions);
    const files = [...pendingFiles];
    const eventId = `local-send-${localSends.length + 1}`;
    localSends = [
      ...localSends,
      {
        eventId,
        fromDisplayName: selfDisplayName?.trim() || "You",
        fromPersonUid: selfPersonUid?.trim() || undefined,
        body,
        createdAt: new Date().toISOString(),
        direction: "out",
        mentions,
        attachments: files.map((file) => ({
          id: file.name,
          vaultPath: file.name,
          name: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          kind: file.type.startsWith("image/") ? "image" : "file",
          previewUrl: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : null,
        })),
      },
    ];
    replyText = "";
    selectedMentions = [];
    mentionHighlight = 0;
    pendingFiles = [];
    attachError = null;
    try {
      await onsend?.(body, mentions, files);
    } catch (err) {
      revokeLocalPreviews(localSends.filter((row) => row.eventId === eventId));
      localSends = localSends.filter((row) => row.eventId !== eventId);
      const raw = err instanceof Error ? err.message.trim() : "";
      attachError = formatComposerSendError(raw, files.length > 0);
    }
  }

  function onReplyKeydown(e: KeyboardEvent): void {
    syncComposerFromDom();
    if (showMentionPicker) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionHighlight = (mentionHighlight + 1) % mentionHits.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionHighlight =
          (mentionHighlight - 1 + mentionHits.length) % mentionHits.length;
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        const hit = mentionHits[mentionHighlight] ?? mentionHits[0];
        if (hit) {
          e.preventDefault();
          applyMention(hit);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        replyText = replyText.replace(/(^|\s)@([^\s@]*)$/, "$1");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  /**
   * Follow the newest message as the timeline grows — but ONLY while the user is
   * pinned to the bottom. The host repolls messages every few seconds; before
   * this was gated, every refresh slammed a history-reading user back down.
   *
   * Tracks the timeline identity (length + newest id) so a same-length refresh
   * still follows for a pinned user. `stickToBottom` / bookkeeping are read via
   * untrack so flipping the flag never re-runs the effect on its own.
   */
  let prevTimelineLength = 0;
  $effect(() => {
    const length = timeline.length;
    void timeline.at(-1)?.eventId;
    untrack(() => {
      const el = scroller;
      const grew = length > prevTimelineLength;
      prevTimelineLength = length;
      if (!el) return;
      if (prependAnchorHeight > 0) {
        // Older history was prepended: hold the user's VISUAL position by
        // shifting scrollTop by exactly the height the prepend added.
        el.scrollTop += el.scrollHeight - prependAnchorHeight;
        prependAnchorHeight = 0;
        return;
      }
      if (stickToBottom) {
        el.scrollTop = el.scrollHeight;
      } else if (grew) {
        hasUnseenBelow = true;
      }
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="conversation chat-shell"
  data-testid="conversation-view"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onclick={onBodyLinkActivate}
  onauxclick={onBodyLinkActivate}
  oncontextmenu={onBodyLinkActivate}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") onBodyLinkActivate(e);
  }}
>
  {#if dragActive}
    <div class="drop-overlay" data-testid="composer-drop-overlay">
      <div class="drop-overlay-card">Drop files to attach</div>
    </div>
  {/if}
  <div class="conversation-body">
    <div class="dm-thread-wrap">
      <div
        class="dm-thread"
        bind:this={scroller}
        onscroll={onThreadScroll}
        data-testid="conversation-thread"
      >
        {#if header}{@render header()}{/if}
        {#if timeline.length === 0 && !loading}
          <div
            class="dm-thread-empty"
            data-testid="conversation-empty"
            role="status"
          >
            No messages yet
          </div>
        {/if}
        {#if windowed.hidden > 0}
          <button
            type="button"
            class="dm-load-earlier"
            data-testid="conversation-load-earlier"
            onclick={showEarlier}
          >
            Show {windowed.hidden} earlier
            {windowed.hidden === 1 ? "message" : "messages"}
          </button>
        {/if}
        {#each timeline as msg, index (msg.eventId)}
          {@const systemModel = systemModelForMessage(msg)}
          {@const workActivity = parseWorkSessionEvent(msg.body ?? "")}
          {@const groupStart = startsGroup(index)}
          {#if startsNewDay(index)}
            <div
              class="date-separator"
              data-testid="date-separator"
              aria-label={formatDateSeparator(msg.createdAt)}
            >
              <span>{formatDateSeparator(msg.createdAt)}</span>
            </div>
          {/if}
          {#if systemModel?.kind === "line"}
            <SystemEventLine
              model={systemModel}
              who={systemModel.type === "member_added"
                ? null
                : messageAuthor(msg)}
            />
          {:else if systemModel?.kind === "run_complete"}
            <div
              class="dm-msg dm-msg-in dm-msg-group-start"
              data-testid="run-complete-row"
            >
              <span class="dm-msg-avatar">
                <IdentityMark
                  kind="agent"
                  label={messageAuthor(msg)}
                  agentUid={msg.fromPersonUid}
                  size="regular"
                />
              </span>
              <div class="dm-msg-column">
                <div class="dm-msg-meta">
                  <span class="dm-msg-author">{messageAuthor(msg)}</span>
                  <span class="dm-msg-header-time"
                    >{formatTime(msg.createdAt)}</span
                  >
                </div>
                <RunCompleteCard model={systemModel} {onopenurl} />
                {#if reactionsFor(msg.eventId).length > 0}
                  <ReactionBar
                    messageId={msg.eventId}
                    reactions={reactionsFor(msg.eventId)}
                    ontoggle={toggle}
                  />
                {/if}
              </div>
            </div>
          {:else if workActivity}
            <WorkMeshActivityRow
              activity={{
                ...workActivity,
                actor: resolveWorkActor(workActivity.actor, msg),
              }}
              time={formatTime(msg.createdAt)}
            />
          {:else if msg.body?.trim() || msg.prompt?.trim() || msg.details?.trim() || parseMessageAttachments(msg).length > 0}
            <div
              class="dm-msg dm-msg-{msg.direction === 'out' ? 'out' : 'in'}"
              class:dm-msg-group-start={groupStart}
              class:dm-msg-reply-active={activeRootEventId === msg.eventId}
              data-testid="conversation-message"
              data-event-id={msg.eventId}
              data-reply-count={msg.replyCount ?? 0}
            >
              {#if groupStart}
                <span class="dm-msg-avatar">
                  {#if isAgent(msg)}
                    <IdentityMark
                      kind="agent"
                      label={messageAuthor(msg)}
                      avatarUrl={avatarFor(msg)}
                      agentUid={msg.fromPersonUid}
                      size="regular"
                    />
                  {:else}
                    <IdentityMark
                      kind="person"
                      label={messageAuthor(msg)}
                      avatarUrl={avatarFor(msg)}
                      size="regular"
                    />
                  {/if}
                </span>
              {:else}
                <span class="dm-msg-avatar-spacer" aria-hidden="true">
                  <span class="dm-msg-gutter-time"
                    >{formatTime(msg.createdAt)}</span
                  >
                </span>
              {/if}
              <div class="dm-msg-column">
                {#if groupStart}
                  <div class="dm-msg-meta">
                    {#if onopenprofile && !isAgent(msg) && (msg.fromPersonUid ?? "").trim()}
                      <button
                        type="button"
                        class="dm-msg-author dm-msg-author-btn"
                        data-testid="conversation-author-open"
                        onclick={() => openAuthorProfile(msg)}
                        >{messageAuthor(msg)}</button
                      >
                    {:else}
                      <span class="dm-msg-author">{messageAuthor(msg)}</span>
                    {/if}
                    <span class="dm-msg-header-time"
                      >{formatTime(msg.createdAt)}</span
                    >
                  </div>
                {/if}
                <div class="dm-bubble">
                  {#if msg.body?.trim()}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="dm-bubble-body selectable-text"
                      onclick={(e) => {
                        if (onBodyLinkActivate(e)) return;
                        onMentionActivate(e, e.target);
                      }}
                      onkeydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          if (onBodyLinkActivate(e)) return;
                          onMentionActivate(e, e.target);
                        }
                      }}
                    >
                      {#if isHeavyMessageBody(msg.body ?? "")}
                        <pre class="dm-plain">{clipMessageBodyForDisplay(
                            msg.body ?? "",
                          )}</pre>
                      {:else}
                        {@html applyMentionMarkup(
                          renderMessageBodyMarkdown(msg.body ?? ""),
                          storedMentions(msg),
                        )}
                      {/if}
                    </div>
                  {/if}
                  {#if msg.details?.trim()}
                    <PromptAttachment
                      kind="details"
                      text={msg.details}
                      eventId={msg.eventId}
                    />
                  {/if}
                  {#if msg.prompt?.trim()}
                    <PromptAttachment
                      kind="prompt"
                      text={msg.prompt}
                      eventId={msg.eventId}
                    />
                  {/if}
                  <MessageAttachments
                    attachments={parseMessageAttachments(msg)}
                    onopen={openAttachment}
                    resolveUrl={resolveAttachmentUrl}
                    {onreleaseurl}
                  />
                </div>
                {#if (msg.replyCount ?? 0) > 0}
                  {@const preview = replyMetaFor(msg)}
                  <button
                    type="button"
                    class="dm-replies-count"
                    data-testid="message-replies"
                    aria-label={replyLabel(msg.replyCount ?? 0)}
                    onclick={() => openReply(msg.eventId)}
                  >
                    {#if preview.authors.length}
                      <span
                        class="dm-replies-avatars"
                        data-testid="reply-authors"
                      >
                        {#each preview.authors.slice(0, 3) as a (a.personUid || a.displayName)}
                          <span class="dm-replies-avatar">
                            <IdentityMark
                              kind={a.agent ? "agent" : "person"}
                              label={a.displayName}
                              avatarUrl={(a.personUid && avatarByUid[a.personUid]) ||
                                null}
                              agentUid={a.personUid}
                              size="small"
                            />
                          </span>
                        {/each}
                      </span>
                    {/if}
                    {replyLabel(msg.replyCount ?? 0)}
                    {#if preview.at}
                      <span class="dm-replies-preview">
                        Last reply {formatRelative(preview.at)}
                      </span>
                    {/if}
                  </button>
                {/if}
                <!-- Quick reactions (tap-visible affordance). -->
                <div
                  class="dm-quick-react"
                  role="group"
                  aria-label="Message actions"
                >
                  {#each QUICK_REACT_EMOJI as emoji (emoji)}
                    <button
                      type="button"
                      class="dm-quick-react-btn"
                      onclick={() => toggle(msg.eventId, emoji)}
                      aria-label={`React with ${emoji}`}
                    >
                      {emoji}
                    </button>
                  {/each}
                  <span class="dm-quick-react-picker-wrap">
                    <button
                      type="button"
                      class="dm-quick-react-btn dm-quick-react-more"
                      data-testid="message-react-more"
                      aria-label="Add a reaction"
                      title="Add a reaction"
                      aria-haspopup="menu"
                      aria-expanded={reactPickerFor === msg.eventId}
                      onclick={() =>
                        (reactPickerFor =
                          reactPickerFor === msg.eventId ? null : msg.eventId)}
                    >
                      +
                    </button>
                    {#if reactPickerFor === msg.eventId}
                      <EmojiPicker
                        onpick={(emoji) => {
                          reactPickerFor = null;
                          toggle(msg.eventId, emoji);
                        }}
                        onclose={() => (reactPickerFor = null)}
                      />
                    {/if}
                  </span>
                  <button
                    type="button"
                    class="dm-quick-react-btn dm-quick-reply"
                    data-testid="message-reply-quick"
                    aria-label="Reply in thread"
                    title="Reply in thread"
                    onclick={() => openReply(msg.eventId)}
                  >
                    Reply
                  </button>
                </div>
                {#if reactionsFor(msg.eventId).length > 0}
                  <ReactionBar
                    messageId={msg.eventId}
                    reactions={reactionsFor(msg.eventId)}
                    ontoggle={toggle}
                  />
                {/if}
              </div>
            </div>
          {/if}
        {/each}
        {#if belowMessages}{@render belowMessages()}{/if}
      </div>
      {#if !stickToBottom}
        <button
          type="button"
          class="new-messages-jump"
          class:has-unseen={hasUnseenBelow}
          data-testid="conversation-jump-latest"
          onclick={jumpToLatest}
        >
          {hasUnseenBelow ? "New messages" : "Jump to latest"} ↓
        </button>
      {/if}
    </div>
  </div>

  <div class="dm-reply">
    <div class="dm-reply-composer">
      {#if showMentionPicker}
        <MentionPicker
          hits={mentionHits}
          highlight={mentionHighlight}
          onpick={applyMention}
        />
      {:else if showAgentMenu}
        <div
          class="agent-menu"
          role="listbox"
          aria-label="Agent commands"
          data-testid="agent-slash-menu"
        >
          <button
            type="button"
            class="agent-menu-row"
            role="option"
            aria-selected="true"
          >
            <span class="agent-menu-label">Run an agent</span>
            <span class="agent-menu-hint">Claude Code handoff</span>
          </button>
        </div>
      {/if}
      {#if pendingFiles.length > 0 || attachError}
        <div class="composer-pending" data-testid="composer-pending">
          {#each pendingFiles as file, i (file.name + file.size + i)}
            {#if isImageFile(file)}
              <span class="composer-thumb">
                <img
                  class="composer-thumb-img"
                  src={pendingPreviewUrl(file)}
                  alt={file.name}
                />
                <span class="composer-thumb-name">{file.name}</span>
                <button
                  type="button"
                  class="composer-thumb-remove"
                  aria-label={`Remove ${file.name}`}
                  onclick={() => removePendingFile(i)}
                >
                  ×
                </button>
              </span>
            {:else}
              <span class="composer-chip">
                <span class="composer-chip-name">{file.name}</span>
                <button
                  type="button"
                  class="composer-chip-remove"
                  aria-label={`Remove ${file.name}`}
                  onclick={() => removePendingFile(i)}
                >
                  ×
                </button>
              </span>
            {/if}
          {/each}
          {#if attachError}
            <span class="composer-attach-error">{attachError}</span>
          {/if}
        </div>
      {/if}
      <div class="mention-input-frame">
        {#if replyText.length > 0}
          <div class="mention-input-overlay" aria-hidden="true">
            {#each composerSegments as part, i (`${i}:${part.mention}`)}
              {#if part.mention}
                <span class="composer-mention">{part.text}</span>
              {:else}
                {part.text}
              {/if}
            {/each}
          </div>
        {/if}
        <textarea
          class="dm-reply-input"
          class:has-overlay={replyText.length > 0}
          bind:this={replyInputEl}
          bind:value={replyText}
          oninput={syncComposerFromDom}
          onkeydown={onReplyKeydown}
          onpaste={onComposerPaste}
          {placeholder}
          rows="3"
          aria-label="Reply message"
          data-testid="conversation-composer"
          autocomplete="off"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          data-lt-active="false"
          data-1p-ignore="true"
        ></textarea>
      </div>
    </div>
    <div class="dm-reply-footer">
      <div class="dm-reply-tools">
        <label
          class="dm-tool-btn composer-attach"
          title="Attach a file"
          data-testid="composer-attach"
        >
          <input
            bind:this={attachInputEl}
            type="file"
            class="composer-file-input"
            accept={CHAT_ATTACHMENT_ACCEPT}
            multiple
            data-testid="composer-attach-input"
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
        <div class="dm-tool-emoji-wrap">
          <button
            type="button"
            class="dm-tool-btn"
            onclick={() => (composerEmojiOpen = !composerEmojiOpen)}
            aria-label="Insert emoji"
            title="Insert emoji"
            aria-expanded={composerEmojiOpen}
            aria-haspopup="menu"
            data-testid="composer-emoji"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6.25"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <circle cx="5.75" cy="6.75" r="0.85" fill="currentColor" />
              <circle cx="10.25" cy="6.75" r="0.85" fill="currentColor" />
              <path
                d="M5.5 9.75c.7 1 1.55 1.5 2.5 1.5s1.8-.5 2.5-1.5"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
          </button>
          {#if composerEmojiOpen}
            <EmojiPicker
              onpick={insertComposerEmoji}
              onclose={() => (composerEmojiOpen = false)}
            />
          {/if}
        </div>
        {#if replyText.startsWith("/") || showAgentMenu}
          <button
            type="button"
            class="dm-tool-btn"
            aria-label="Run an agent"
            title="Type / to run an agent"
            onclick={() => {
              if (!replyText.startsWith("/")) replyText = `/${replyText}`;
              replyInputEl?.focus();
            }}
          >
            <span
              aria-hidden="true"
              style="font: 600 13px/1 var(--font-mono, ui-monospace);">/</span
            >
          </button>
        {/if}
      </div>
      <button
        type="button"
        class="btn btn-send"
        class:is-idle={!canSend}
        onclick={send}
        onpointerdown={syncComposerFromDom}
        aria-disabled={!canSend}
        aria-label="Send"
        title="Send"
        data-testid="composer-send"
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
  {#if trayOpen && !onopenattachment}
    <AttachmentTray
      items={conversationAttachments}
      selectedId={traySelectedId}
      onselect={(id) => (traySelectedId = id)}
      onclose={() => (trayOpen = false)}
      resolveUrl={resolveAttachmentUrl}
      {onreleaseurl}
      {onopenurl}
    />
  {/if}
  {#if linkMenu}
    <LinkContextMenu
      menu={linkMenu}
      {onopenurl}
      onclose={() => (linkMenu = null)}
    />
  {/if}
</div>

<style>
  .conversation {
    position: relative;
    /* Own stacking context so z-indexed hover chrome (.dm-quick-react z2,
       .dm-reply z1, .agent-menu z20, .drop-overlay z40) cannot paint into a
       sibling pane. Isolation only — no extra overflow clip; EmojiPicker and
       .agent-menu are inline absolute inside this pane and must stay visible.
       .dm-msg is position:relative (z-index auto), so without this context its
       box paints in the ancestor's positioned layer above an unpositioned
       .reply-column — message text would cross the divider. */
    isolation: isolate;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    font: 400 13px/1.45 var(--font-ui);
    color: var(--t1);
  }

  .conversation-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .composer-attach {
    position: relative;
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--pop-bg, #101014) 55%, transparent);
    pointer-events: none;
  }

  .drop-overlay-card {
    padding: 14px 22px;
    border: 1px dashed var(--c-field-border, var(--pop-border));
    border-radius: 12px;
    background: var(--pop-bg);
    color: var(--t1, var(--pop-text));
    font: 500 13px/1.3 var(--font-ui);
    box-shadow: var(--pop-shadow);
  }

  .composer-file-input {
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

  .composer-pending {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 2px 8px;
  }

  .composer-thumb {
    position: relative;
    display: inline-flex;
    width: 56px;
    height: 56px;
    overflow: hidden;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    background: var(--sel, rgba(255, 255, 255, 0.06));
  }

  .composer-thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .composer-thumb-name {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 1px 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: var(--t2, rgba(255, 255, 255, 0.56));
    background: var(--bg, rgba(0, 0, 0, 0.6));
    opacity: 0.9;
  }

  .composer-thumb-remove {
    position: absolute;
    top: 0;
    right: 0;
    appearance: none;
    border: 0;
    padding: 0 4px;
    line-height: 16px;
    background: var(--bg, rgba(0, 0, 0, 0.6));
    color: var(--t2);
    cursor: pointer;
  }

  .composer-thumb-remove:hover {
    background: var(--sel, rgba(255, 255, 255, 0.12));
    color: var(--t1, #fff);
  }

  .composer-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 4px 8px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 999px;
    background: var(--sel, rgba(255, 255, 255, 0.06));
    font-size: 12px;
  }

  .composer-chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-chip-remove {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }

  .composer-attach-error {
    /* Soft status — never alarm red (Indigo / HQ anti-pattern). */
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-size: 12px;
  }

  .dm-thread-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .dm-thread {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-x: hidden;
    overflow-y: auto;
    /* 16px bottom so the last message's reaction bar doesn't kiss the
       composer frame. */
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--line, var(--pop-muted)) transparent;
  }

  .dm-thread::-webkit-scrollbar {
    width: 4px;
  }
  .dm-thread::-webkit-scrollbar-thumb {
    background: var(--line);
    border-radius: 999px;
  }

  .dm-thread-empty {
    margin: auto;
    padding: 48px 16px;
    color: var(--t3);
    font-size: 13px;
    text-align: center;
  }

  /* Floating "jump to latest" pill — lives in the positioned wrap, NOT in the
     scroller, so it holds still while history scrolls behind it. */
  .new-messages-jump {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 2;
    padding: 5px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg2, var(--bg1));
    color: var(--t2, var(--t1));
    font: 500 12px/1.3 var(--font-ui);
    white-space: nowrap;
    cursor: pointer;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--t1) 14%, transparent);
  }
  .new-messages-jump:hover {
    background: var(--hover, color-mix(in srgb, var(--t1) 6%, transparent));
    color: var(--t1);
  }
  .new-messages-jump.has-unseen {
    border-color: var(--accent, var(--line));
    color: var(--accent, var(--t1));
  }

  .dm-load-earlier {
    display: block;
    width: calc(100% - 24px);
    margin: 8px 12px 4px;
    padding: 6px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t3);
    font: 500 12px/1.3 var(--font-ui);
    text-align: center;
    cursor: pointer;
  }
  .dm-load-earlier:hover {
    background: var(--hover, color-mix(in srgb, var(--t1) 6%, transparent));
    color: var(--t2, var(--t1));
  }

  /* Authored rows — avatar column + message column. Messages read as authored
     name+text rows (NOT opposing chat bubbles); the signed-in sender is just
     another left-aligned row labelled "You". Ported from the desktop
     Conversation.svelte canonical `.dm-msg` grid treatment. */
  .dm-msg {
    position: relative;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: start;
    gap: 8px;
    width: 100%;
    max-width: none;
    margin-top: 2px;
    padding: 5px 8px;
    border-radius: 6px;
  }

  .dm-msg:hover,
  .dm-msg:focus-within {
    background: color-mix(in srgb, var(--t1) 4%, transparent);
  }

  .dm-msg-group-start {
    margin-top: 10px;
    padding-top: 2px;
  }

  .date-separator + .dm-msg {
    margin-top: 0.25rem;
  }

  .dm-msg-avatar,
  .dm-msg-avatar-spacer {
    display: grid;
    place-items: start center;
    flex: 0 0 36px;
    width: 36px;
    min-height: 1px;
    padding-top: 2px;
  }

  .dm-msg-gutter-time {
    display: block;
    width: 100%;
    color: var(--t3);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    line-height: 18px;
    text-align: center;
    opacity: 0;
  }

  .dm-msg:hover .dm-msg-gutter-time,
  .dm-msg:focus-within .dm-msg-gutter-time {
    opacity: 1;
  }

  .dm-msg-column {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    max-width: 720px;
  }

  .dm-msg-meta {
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    margin: 0 0 0.125rem;
    min-width: 0;
  }

  .dm-msg-author {
    max-width: 42ch;
    overflow: hidden;
    color: var(--t1);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button.dm-msg-author-btn {
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }

  button.dm-msg-author-btn:hover {
    text-decoration: underline;
  }

  button.dm-msg-author-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
    border-radius: 4px;
  }

  .dm-msg-header-time {
    flex: 0 0 auto;
    color: var(--t3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    line-height: 1.45;
    opacity: 1;
  }

  /* Plain text row — no bubble background/border for either direction. Only
     real objects (shared files) would get card treatment. */
  .dm-bubble {
    position: relative;
    width: 100%;
    max-width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-self: flex-start;
  }

  .dm-bubble-details {
    margin: 0;
    padding: 8px 10px;
    border-left: 2px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 6px;
    background: var(--raised, rgba(255, 255, 255, 0.04));
    color: var(--t2, rgba(255, 255, 255, 0.72));
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 12px;
    line-height: 18px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .dm-bubble-body {
    --message-markdown-text: var(--t2, var(--fg, var(--pop-text, #e8e8e8)));
    --message-markdown-muted: var(
      --t3,
      var(--muted, var(--pop-muted, #a0a0a0))
    );
    --message-markdown-border: var(
      --line,
      var(--border, var(--pop-divider, rgba(255, 255, 255, 0.14)))
    );
    --message-markdown-surface: var(
      --raised,
      var(--surface-raise, var(--c-field-bg, rgba(255, 255, 255, 0.06)))
    );
    min-width: 0;
    max-width: 100%;
    margin: 0;
    font-family: var(--font-ui);
    /* Match the sidebar row size (13px) — 15px made timeline text visibly
       larger than the rest of the shell. */
    font-size: 13px;
    line-height: 1.5;
    color: var(--t1, var(--message-markdown-text));
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .dm-bubble-body > :global(:first-child) {
    margin-top: 0;
  }

  .dm-bubble-body :global(pre.dm-plain) {
    margin: 0;
    max-height: 240px;
    overflow: auto;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--raised, rgba(255, 255, 255, 0.04));
    font: 12px/1.4 var(--font-mono, ui-monospace, Menlo, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .dm-bubble-body > :global(:last-child) {
    margin-bottom: 0;
  }

  .dm-bubble-body :global(p) {
    margin: 0.375rem 0;
    color: inherit;
  }

  .dm-bubble-body :global(h1),
  .dm-bubble-body :global(h2),
  .dm-bubble-body :global(h3),
  .dm-bubble-body :global(h4),
  .dm-bubble-body :global(h5),
  .dm-bubble-body :global(h6) {
    margin: 1rem 0 0.4rem;
    color: var(--message-markdown-text);
    font-weight: 650;
    line-height: 1.18;
    letter-spacing: -0.02em;
  }

  .dm-bubble-body :global(h1) {
    font-size: 1.42em;
  }
  .dm-bubble-body :global(h2) {
    font-size: 1.28em;
  }
  .dm-bubble-body :global(h3) {
    font-size: 1.14em;
  }
  .dm-bubble-body :global(h4),
  .dm-bubble-body :global(h5),
  .dm-bubble-body :global(h6) {
    font-size: 1em;
  }

  .dm-bubble-body :global(ul),
  .dm-bubble-body :global(ol) {
    margin: 0.625rem 0;
    padding-left: 1.4rem;
  }

  .dm-bubble-body :global(li) {
    margin: 0.3rem 0;
    padding-left: 0.2rem;
    line-height: 1.5;
  }

  .dm-bubble-body :global(li > ul),
  .dm-bubble-body :global(li > ol) {
    margin: 0.1875rem 0;
  }

  .dm-bubble-body :global(.task-list) {
    padding-left: 0;
    list-style: none;
  }

  .dm-bubble-body :global(.task-list-item) {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding-left: 0;
  }

  .dm-bubble-body :global(.task-list-item input) {
    flex: 0 0 auto;
    margin: 0.25em 0 0;
    accent-color: var(--message-markdown-muted);
  }

  .dm-bubble-body :global(.task-list-content) {
    min-width: 0;
  }

  .dm-bubble-body :global(a) {
    color: var(--message-markdown-muted);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
    text-underline-offset: 0.125rem;
  }

  .dm-bubble-body :global(a:hover) {
    text-decoration-color: currentColor;
  }

  .dm-bubble-body :global(strong) {
    color: var(--message-markdown-text);
    font-weight: 650;
  }

  .dm-bubble-body :global(del) {
    color: var(--message-markdown-muted);
  }

  .dm-bubble-body :global(code) {
    padding: 0.0625rem 0.25rem;
    border-radius: 4px;
    background: var(--message-markdown-surface);
    color: var(--message-markdown-text);
    font-family: var(
      --font-mono,
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace
    );
    font-size: 0.92em;
  }

  .dm-bubble-body :global(pre) {
    max-width: 100%;
    margin: 0.625rem 0;
    padding: 0.625rem 0.75rem;
    overflow-x: auto;
    border: 1px solid var(--message-markdown-border);
    background: var(--message-markdown-surface);
    color: var(--message-markdown-text);
    line-height: 1.5;
    white-space: pre;
    overflow-wrap: normal;
    word-break: normal;
  }

  .dm-bubble-body :global(pre code) {
    padding: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-size: 0.9em;
    white-space: inherit;
  }

  .dm-bubble-body :global(blockquote) {
    margin: 0.625rem 0;
    padding: 0.0625rem 0 0.0625rem 0.75rem;
    border-left: 2px solid var(--message-markdown-border);
    background: transparent;
    color: var(--message-markdown-muted);
  }

  .dm-bubble-body :global(blockquote p) {
    color: inherit;
  }

  .dm-bubble-body :global(hr) {
    margin: 0.75rem 0;
    border: 0;
    border-top: 1px solid var(--message-markdown-border);
  }

  .dm-bubble-body :global(.markdown-table-scroll) {
    width: 100%;
    max-width: 100%;
    margin: 0.625rem 0;
    overflow-x: auto;
  }

  .dm-bubble-body :global(table) {
    width: 100%;
    min-width: max-content;
    border-collapse: collapse;
    color: inherit;
    font-size: 0.9em;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }

  .dm-bubble-body :global(th),
  .dm-bubble-body :global(td) {
    padding: 0.4375rem 0.625rem;
    border-right: 1px solid var(--message-markdown-border);
    border-bottom: 1px solid var(--message-markdown-border);
    text-align: left;
    vertical-align: top;
  }

  .dm-bubble-body :global(th:first-child),
  .dm-bubble-body :global(td:first-child) {
    padding-left: 0;
  }

  .dm-bubble-body :global(th:last-child),
  .dm-bubble-body :global(td:last-child) {
    padding-right: 0;
    border-right: 0;
  }

  .dm-bubble-body :global(tbody tr:last-child td) {
    border-bottom: 0;
  }

  .dm-bubble-body :global(th) {
    color: var(--message-markdown-text);
    font-weight: 650;
  }

  .dm-bubble-body :global(.markdown-align-center) {
    text-align: center;
  }

  .dm-bubble-body :global(.markdown-align-right) {
    text-align: right;
  }

  /* Slack day pill — hairline through the row, label centered in a chip. */
  .date-separator {
    display: flex;
    align-items: center;
    gap: 0;
    margin: 12px 8px;
    color: var(--t2);
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
  }

  .date-separator::before,
  .date-separator::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  .date-separator span {
    margin: 0 12px;
    padding: 2px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--v4-ground, var(--raised, #161618));
  }

  .dm-msg-reply-active {
    background: color-mix(in srgb, var(--t1) 5%, transparent);
  }

  .dm-replies-count {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin: 4px 0 0;
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    /* Neutral text tokens, not link blue: primary weight for the count, the
       trailing preview stays muted (--t3 below). */
    color: var(--t1);
    font: 600 13px/1.3 var(--font-ui);
    cursor: pointer;
  }

  .dm-replies-count:hover,
  .dm-replies-count:focus-visible {
    border-color: var(--line);
    background: var(--hover, color-mix(in srgb, var(--t1) 5%, transparent));
    outline: none;
  }

  .dm-replies-preview {
    color: var(--t3);
    font-weight: 400;
  }

  /* Slack-style overlapping participant avatars, left of "N replies". */
  .dm-replies-avatars {
    display: inline-flex;
    align-items: center;
  }

  .dm-replies-avatar {
    display: inline-flex;
    margin-left: -6px;
    border-radius: 999px;
    box-shadow: 0 0 0 2px var(--v4-ground, var(--raised, #161618));
  }

  .dm-replies-avatar:first-child {
    margin-left: 0;
  }

  /* Slack-style hover toolbar pinned to the message. */
  .dm-quick-react {
    position: absolute;
    top: -14px;
    right: 8px;
    z-index: 2;
    display: flex;
    gap: 2px;
    margin: 0;
    padding: 2px;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    /* Opaque floating bar: composite the (translucent) panel token over the
       solid window ground so the message never bleeds through it. */
    background-color: var(--v4-ground, #1c1c1f);
    background-image: linear-gradient(var(--panel-bg), var(--panel-bg));
    box-shadow: var(--panel-shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }

  .dm-msg:hover .dm-quick-react,
  .dm-msg:focus-within .dm-quick-react,
  .dm-quick-react:has([aria-expanded="true"]) {
    opacity: 1;
    pointer-events: auto;
  }

  /* Touch input has no hover state, so a hover-only toolbar is unreachable. */
  @media (hover: none) {
    .dm-quick-react {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .dm-quick-react-picker-wrap {
    position: relative;
    display: inline-flex;
  }

  .dm-quick-react-more {
    color: var(--t2, var(--pop-muted));
    font-weight: 600;
  }

  .dm-quick-react-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 28px;
    padding: 0 0.25rem;
    border: 0;
    border-radius: 6px;
    background: var(--pop-hover);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }

  .dm-quick-react-btn:hover {
    background: var(--c-field-bg);
  }

  .dm-quick-reply {
    padding: 0 8px;
    color: var(--t1);
    font: 500 11px/1 var(--font-ui);
  }

  /* Composer (real desktop dm-reply). */
  .dm-reply {
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    margin: 0 16px 20px;
    padding: 8px 8px 8px 12px;
    background: var(--raised, var(--pop-hover));
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 8px;
    transition: border-color 0.12s;
  }

  .dm-reply:focus-within {
    border-color: var(--border-active, var(--c-field-border));
  }

  .dm-reply-composer {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .mention-input-frame {
    position: relative;
  }

  .mention-input-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow: hidden;
    color: transparent;
    font: 400 13px/1.5 var(--font-ui);
  }

  .composer-mention {
    background: rgba(99, 102, 241, 0.28);
    border-radius: 3px;
    color: transparent;
    font-weight: 700;
  }

  .dm-reply-input {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    padding: 0;
    border-radius: 0;
    border: none;
    background: none;
    color: var(--t1, var(--pop-text));
    font: 400 13px/1.5 var(--font-ui);
    caret-color: var(--t1, #f4f4f5);
  }

  .dm-bubble-body :global(.inline-mention) {
    background: rgba(99, 102, 241, 0.2);
    border-radius: 3px;
    /* Theme-aware ink: the raw #c7d2fe (light lavender) is legible on the dark
       ground but invisible in light theme. --vio-ink flips per theme
       (light #854dee / dark #e0c4fe), keeping mentions readable in both. */
    color: var(--vio-ink, #c7d2fe);
    font-weight: 700;
    padding: 0 2px;
  }

  .dm-msg-out .dm-bubble-body :global(.inline-mention) {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
  }

  /* Clickable mentions (human, carry a person uid) open the profile panel. */
  .dm-bubble-body :global(.inline-mention[data-person-uid]) {
    cursor: pointer;
  }

  .dm-bubble-body :global(.inline-mention[data-person-uid]:hover) {
    text-decoration: underline;
  }

  .dm-reply-input::placeholder {
    color: var(--t3);
  }

  .dm-reply-input:focus {
    outline: none;
  }

  .agent-menu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 20;
    min-width: 220px;
    padding: 4px;
    border-radius: 10px;
    border: 1px solid var(--pop-border);
    background: var(--pop-bg);
    box-shadow: var(--pop-shadow);
  }

  .agent-menu-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    cursor: pointer;
  }

  .agent-menu-row.selected,
  .agent-menu-row:hover {
    background: var(--sel);
  }

  .agent-menu-hint {
    color: var(--t3);
    font-size: 11px;
  }

  .dm-reply-footer {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .dm-reply-tools {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: -6px;
  }

  .dm-tool-emoji-wrap {
    position: relative;
    display: inline-flex;
  }

  .dm-tool-btn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t3, var(--pop-muted));
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .dm-tool-btn:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .btn-send {
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

  .btn-send:hover:not(:disabled):not(.is-idle):not([aria-disabled="true"]) {
    opacity: 0.88;
  }

  .btn-send:active:not(:disabled):not(.is-idle):not([aria-disabled="true"]) {
    transform: scale(0.95);
  }

  .btn-send:disabled,
  .btn-send.is-idle,
  .btn-send[aria-disabled="true"] {
    opacity: 0.4;
    cursor: default;
  }
</style>
