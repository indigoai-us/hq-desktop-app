<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * ReplyPanel — Slack-style reply column (port of hq-desktop-app ThreadPanel).
   * Chrome says “Thread” (Slack). Overlay vs third-column lives in the
   * host (ConversationView / DesktopApp).
   *
   * ZERO extra fetch after send — cache-first; the host must not re-GET the
   * whole reply thread on ack (hq-work-desktop-io-off-main-thread).
   */
  import { onMount, untrack } from "svelte";

  import "./message-row.css";
  import IdentityMark from "./IdentityMark.svelte";
  import { authorAvatarUrl } from "./agent-avatars";
  import type { ImagePreviewCache } from "./image-preview-cache";
  import MessageAttachments from "./MessageAttachments.svelte";
  import ComposerPendingAttachments from "./ComposerPendingAttachments.svelte";
  import ArtifactCard from "./ArtifactCard.svelte";
  import type { ChatArtifact } from "./artifact-model.js";
  import ReactionBar from "./ReactionBar.svelte";
  import { buildMessageLink } from "./message-link";
  import EmojiPicker from "./EmojiPicker.svelte";
  import MentionPicker from "./MentionPicker.svelte";
  import type { LocalBotRow } from "@hq/platform";
  import AgentThinkingRow from "./AgentThinkingRow.svelte";
  import {
    clearFromMessages,
    isAgentUid,
    newestMessageAtFrom,
    startThinking,
    agentDisplayName,
    applyAgentStatus,
    type AgentStatusWake,
    tick,
    type ThinkingEntry,
  } from "../agent-thinking.js";
  import {
    activeMentionQuery,
    applyMentionMarkup,
    filterMentionCandidates,
    mentionPayloadTargets,
    mentionsPresentInBody,
    mentionTextForTarget,
    mergeMentionTargets,
    replaceActiveMention,
    storedMentionType,
    withHereMention,
    type MentionTarget,
  } from "../mentions.js";
  import {
    parseMessageAttachments,
    parseForwardedFrom,
    parseOmittedAttachments,
    forwardNoteText,
  } from "./channelMessageModels";
  import ForwardedBlock from "./ForwardedBlock.svelte";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import {
    CHAT_ATTACHMENT_ACCEPT,
    MAX_CHAT_ATTACHMENTS,
    filesFromDataTransfer,
    namePastedImageFile,
    validateChatAttachment,
    type ChatAttachmentValidator,
    type ChatAttachmentWire,
  } from "./chat-attachments";
  import {
    formatComposerSendError,
    isTerminalSendError,
  } from "./composer-send-error";
  import { uploadErrorUpgradeUrl } from "./upload-chat-attachments";
  import AgentTaskStrip from "../tasks/AgentTaskStrip.svelte";
  import type { AgentTask } from "../tasks/agent-tasks";
  import {
    toggleReaction,
    type ReactionAggregate,
    type ReactionMap,
  } from "./reactions";
  import {
    isHeavyMessageBody,
    renderMessageBodyMarkdown,
  } from "../../common/messageMarkdown.js";
  import { isJumboEmojiBody } from "../../common/emojiShortcodes.js";
  import PlainMessageBody from "./PlainMessageBody.svelte";
  import RichMessageContent from "./RichMessageContent.svelte";
  import { richContentForMessage, type ExtractedRichContent } from "./richMessageContent";
  import type { DecisionOption } from "./richMessageContent";
  import { decisionAnswersFromMessages } from "./decision-answers";
  import LinkContextMenu from "../../common/LinkContextMenu.svelte";
  import {
    handleLinkActivate,
    type LinkMenuAnchor,
  } from "../../common/external-links.js";
  import type {
    ChatWakeBus,
    ConversationApi,
    ConversationMessageWire,
    ReplyThreadScope,
  } from "../chat-api";
  import { subscribeAgentStatus, subscribeReplyNew } from "../chat-api";

  export interface ReplyPreviewAuthor {
    personUid: string;
    displayName: string;
    agent?: boolean;
  }

  export interface ReplyPreview {
    author: string;
    at: string;
    /** Distinct reply authors, first-appearance order (Slack-style avatar
     *  stack in the main-chat affordance; consumers cap the render). */
    authors?: ReplyPreviewAuthor[];
  }

  interface LocalReply extends ConversationMessageWire {
    sendStatus?: "sending" | "failed";
    /** Human reason a failed reply did not land — shown beside the row. */
    sendError?: string;
    /**
     * The server refused the request itself (a mention it will never accept, a
     * list over the cap). Retrying the identical payload always fails, so the
     * row shows the reason WITHOUT a retry affordance.
     */
    sendFatal?: boolean;
  }

  interface Props {
    api: ConversationApi;
    rootEventId: string;
    scope: ReplyThreadScope;
    /** Background tasks spawned from THIS thread's root message (room view). */
    tasks?: AgentTask[];
    channelId?: string | null;
    withPersonUid?: string | null;
    /** Display name of the DM counterpart (the agent in an agent DM). */
    withPersonName?: string | null;
    /** Channel display name for the header and the "Also send to #channel" switch. */
    channelName?: string | null;
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
    previewCache?: ImagePreviewCache | null;
    onpresign?: (
      companyUid: string,
      vaultPath: string,
    ) => Promise<string | null>;
    /** Open the host attachment viewer (optional — thumbs render regardless). */
    onopenattachment?: (item: FileAttachmentModel) => void;
    /** Host opens a long artifact (details/prompt) in the side pane. */
    onopenartifact?: (artifact: ChatArtifact) => void;
    /** Releases host-created object URLs when inline reply images unmount. */
    onreleaseurl?: (url: string) => void;
    /** Fallback company for vault presign when a wire attachment omits it. */
    vaultCompanyUid?: string | null;
    /** Company of the conversation, for "Copy link". */
    companyUid?: string | null;
    onclose: () => void;
    onreplycount?: (
      rootEventId: string,
      replyCount: number,
      preview?: ReplyPreview | null,
    ) => void;
    /** Host-only active-thread registration for native realtime reconciliation. */
    onactivethreadchange?: (
      active:
        | {
            rootEventId: string;
            scope: ReplyThreadScope;
            channelId?: string | null;
            withPersonUid?: string | null;
            seenReplyIds: string[];
          }
        | null,
    ) => void;
    /** personUid → presigned avatar URL for real profile photos. */
    avatarByUid?: Record<string, string>;
    /** personUid → live roster display name (profile override). */
    displayNameByUid?: Record<string, string>;
    /** Host-specific attachment limits; desktop uses the shared 25 MB default. */
    attachmentValidator?: ChatAttachmentValidator;
    /** Open a person's profile panel when their name/avatar/mention is clicked. */
    onopenprofile?: (author: {
      personUid: string;
      displayName: string;
    }) => void;
    /** Company/contacts roster for @ completion. Empty = no picker. */
    mentionCandidates?: MentionTarget[];
    /**
     * Offer `@here` in the mention picker. True for a channel and for a group
     * DM; false for a 1:1 DM, where there is one other person and they are
     * already notified.
     */
    allowHereMention?: boolean;
    selfPersonUid?: string | null;
    /** Platform seam for opening an external URL from a message-body link. */
    onopenurl?: (url: string) => void;
    /** The user's local bots — tells the Cloud / Local chip which is which. */
    localBots?: ReadonlyArray<LocalBotRow> | null;
  }

  let {
    api,
    rootEventId,
    scope,
    channelId = null,
    withPersonUid = null,
    withPersonName = null,
    channelName = null,
    seedRoot = null,
    wakes = null,
    reactions = {},
    ontogglereaction,
    selfDisplayName = null,
    selfPersonUid = null,
    onuploadfiles = undefined,
    previewCache,
    onpresign = undefined,
    onopenattachment = undefined,
    onopenartifact = undefined,
    onreleaseurl = undefined,
    vaultCompanyUid = null,
    companyUid = null,
    onclose,
    onreplycount,
    onactivethreadchange,
    avatarByUid = {},
    displayNameByUid = {},
    attachmentValidator = validateChatAttachment,
    onopenprofile,
    mentionCandidates = [],
    allowHereMention = false,
    onopenurl,
    tasks = [],
    localBots = null,
  }: Props = $props();

  const QUICK_REACT_EMOJI = ["👍", "🎉"] as const;
  let reactPickerFor = $state<string | null>(null);

  /** `id:<eventId>` or `link:<eventId>` whose copy just succeeded. */
  let copiedKey = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  const linkConversationId = $derived(
    ((scope === "channel" ? channelId : withPersonUid) ?? "").trim() || null,
  );
  const linkCompanyUid = $derived(
    (companyUid ?? vaultCompanyUid ?? "").trim() || null,
  );

  async function writeClipboard(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    copiedKey = key;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedKey = null;
      copiedTimer = null;
    }, 1500);
  }

  async function copyId(eventId: string): Promise<void> {
    await writeClipboard(eventId, `id:${eventId}`);
  }

  async function copyLink(eventId: string): Promise<void> {
    if (!linkConversationId || !linkCompanyUid) return;
    await writeClipboard(
      buildMessageLink({
        companyUid: linkCompanyUid,
        conversationId: linkConversationId,
        eventId,
      }),
      `link:${eventId}`,
    );
  }

  /** Open the author's profile or agent pane. */
  function openAuthorProfile(msg: ConversationMessageWire | null): void {
    if (!msg || !onopenprofile) return;
    const personUid = (msg.fromPersonUid ?? "").trim();
    if (!personUid) return;
    onopenprofile({ personUid, displayName: messageAuthor(msg) });
  }

  /** Delegated open when a clickable @mention span is activated in a body. */
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

  function storedMentions(
    msg: ConversationMessageWire | null,
  ): MentionTarget[] {
    return (msg?.mentions ?? []).map((row) => ({
      participantUid: row.participantUid,
      participantType: storedMentionType(row),
      displayName: row.displayName,
    }));
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
  let pendingFiles = $state.raw<File[]>([]);
  let attachError = $state<string | null>(null);
  // Upgrade link for a plan-limit upload refusal; only shown beside the
  // attach error it came with (hard-stop US-018).
  let attachUpgradeUrl = $state<string | null>(null);
  let pasteCounter = 0;
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let selectedMentions = $state<MentionTarget[]>([]);
  let mentionHighlight = $state(0);
  // Thread-local thinking rows — the panel owns its send + reply merge, so
  // the indicator stays self-contained (no DesktopApp plumbing).
  const AGENT_THINKING_TICK_MS = 5_000;
  let agentThinking = $state<ThinkingEntry[]>([]);

  onMount(() => {
    const handle = window.setInterval(() => {
      // `tick` returns the same reference when nothing flipped/expired; only
      // touch $state when it actually minted a new array.
      const next = tick(agentThinking, Date.now());
      if (next !== agentThinking) agentThinking = next;
    }, AGENT_THINKING_TICK_MS);
    return () => clearInterval(handle);
  });

  function startThinkingForMentions(mentions: MentionTarget[]): void {
    const now = Date.now();
    for (const mention of mentions) {
      if (mention.participantType !== "agent") continue;
      agentThinking = startThinking(
        agentThinking,
        {
          agentUid: mention.participantUid,
          agentName: mention.displayName,
        },
        now,
      );
    }
  }

  /**
   * Start the working indicator for the agent this thread is addressed to, even
   * when the reply carries no @mention — answering a decision card (or any plain
   * reply in an agent DM thread / on an agent-authored root) is inherently
   * addressed to that agent, mirroring the DM branch in DesktopApp.persistSend.
   * The mention path above already covers channel threads with an explicit
   * @agent, so this only fires when no agent mention was present.
   */
  function startThinkingForThreadAgent(mentions: MentionTarget[]): void {
    if (mentions.some((m) => m.participantType === "agent")) return;
    // A 1:1 agent DM thread: the counterpart uid is the agent.
    if (scope === "dm" && withPersonUid && isAgentUid(withPersonUid.trim())) {
      const uid = withPersonUid.trim();
      agentThinking = startThinking(
        agentThinking,
        {
          agentUid: uid,
          agentName: agentDisplayName(uid, [...(root ? [root] : []), ...replies], {
            liveNames: displayNameByUid,
            fallback: withPersonName,
          }),
        },
        Date.now(),
        // Fast responders (local bots): only a reply newer than their last
        // one may clear the row; see agent-thinking.ts `afterMs`.
        { afterMs: newestMessageAtFrom([...(root ? [root] : []), ...replies], uid) },
      );
      return;
    }
    // Otherwise wake the agent that authored the root (e.g. a decision card the
    // agent posted into a channel thread).
    const rootUid = (root?.fromPersonUid ?? "").trim();
    if (root && isAgentUid(rootUid)) {
      agentThinking = startThinking(
        agentThinking,
        { agentUid: rootUid, agentName: messageAuthor(root) },
        Date.now(),
      );
    }
  }

  // Persisted answered-decision state for this thread (root + replies, oldest →
  // newest) so cards lock + highlight their choice across reload / reopen.
  const answeredDecisions = $derived(
    decisionAnswersFromMessages([
      ...(root ? [root] : []),
      ...replies,
    ]),
  );
  const answeredQuestionIds = $derived(new Set(answeredDecisions.keys()));
  const answeredChoices = $derived.by(() => {
    const map = new Map<string, string>();
    for (const [qid, answer] of answeredDecisions) {
      if (answer.label !== undefined) map.set(qid, answer.label);
    }
    return map;
  });

  /** Timestamp-aware: `load()` re-fetches the WHOLE thread on every
   *  reply:new wake, so a historical agent reply must not clear a row that
   *  started after it. */
  function clearThinkingFromReplies(
    list: ConversationMessageWire[],
  ): void {
    if (agentThinking.length === 0) return;
    agentThinking = clearFromMessages(agentThinking, list);
  }

  const mentionQuery = $derived(activeMentionQuery(draft));
  const mentionHits = $derived(
    filterMentionCandidates(
      withHereMention(mentionCandidates, allowHereMention),
      mentionQuery,
      selectedMentions,
    ),
  );
  const showMentionPicker = $derived(mentionQuery !== null);

  $effect(() => {
    void mentionQuery;
    mentionHighlight = 0;
  });

  function applyMention(target: MentionTarget): void {
    draft = replaceActiveMention(draft, mentionTextForTarget(target));
    selectedMentions = mergeMentionTargets(selectedMentions, target);
    mentionHighlight = 0;
    composerEl?.focus();
  }

  $effect(() => {
    localReactions = { ...reactions };
  });

  function messageAuthor(msg: ConversationMessageWire): string {
    const uid = (msg.fromPersonUid ?? "").trim();
    const live = uid ? displayNameByUid[uid]?.trim() : "";
    return live || msg.fromDisplayName?.trim() || msg.fromEmail || "Unknown";
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
    // Distinct reply authors (keyed by personUid, falling back to the display
    // name for rows without a uid), first-appearance order.
    const authors: ReplyPreviewAuthor[] = [];
    const seen = new Set<string>();
    for (const msg of list) {
      const personUid = (msg.fromPersonUid ?? "").trim();
      const displayName = messageAuthor(msg);
      const key = personUid || displayName;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      authors.push({ personUid, displayName, agent: isAgent(msg) });
    }
    return { author, at, authors };
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

  /** First trimmed eventId wins — keyed `{#each replies as msg (msg.eventId)}`
   *  cannot receive duplicate keys (API page listed twice, or load + live
   *  append of the same server row). */
  function dedupeByEventId<T extends { eventId?: string | null }>(
    messages: T[],
  ): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const message of messages) {
      const id = (message.eventId ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(message);
    }
    return out;
  }

  /** Fold a server page onto the in-memory list: drop/replace the matching
   *  optimistic `local-` row (same trimmed body + direction out) and keep
   *  only still-in-flight sending|failed locals that have no server copy. */
  function mergeServerReplies(
    serverRows: ConversationMessageWire[],
    current: LocalReply[],
  ): LocalReply[] {
    const ordered = dedupeByEventId(serverRows);
    const consumed = new Set<string>();
    const pending: LocalReply[] = [];
    for (const row of current) {
      if (!row.eventId.startsWith("local-")) continue;
      const match = ordered.find(
        (server) =>
          !consumed.has(server.eventId) &&
          (server.direction ?? "out") === "out" &&
          (row.direction ?? "out") === "out" &&
          (server.body ?? "").trim() === (row.body ?? "").trim(),
      );
      if (match) {
        consumed.add(match.eventId);
        continue;
      }
      if (row.sendStatus === "sending" || row.sendStatus === "failed") {
        pending.push(row);
      }
    }
    return dedupeByEventId([...ordered, ...pending]);
  }

  const visibleReplies = $derived(dedupeByEventId(replies));

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

  function reportActiveThread(): void {
    onactivethreadchange?.({
      rootEventId,
      scope,
      ...(scope === "channel" ? { channelId } : { withPersonUid }),
      seenReplyIds: [...seenIds],
    });
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
      // Branch's mergeServerReplies supersedes the plain pending-filter: it
      // preserves in-flight/failed local sends AND dedupes server echoes of
      // already-rendered local replies.
      replies = mergeServerReplies(ordered, replies);
      seenIds = new Set(replies.map((row) => row.eventId));
      reportActiveThread();
      clearThinkingFromReplies(ordered);
      emitCount(view.replyCount ?? ordered.length, ordered);
    } catch (err) {
      if (generation !== loadGeneration || rootEventId !== requested) return;
      // Thrown text is transport/server output: log it, show plain copy.
      console.warn("[reply-panel] load replies failed", err);
      loadError = "Could not load replies. Try again.";
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
      const error = attachmentValidator(file);
      if (error) {
        errors.push(error.message);
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
    attachUpgradeUrl = null;
  }

  function removePendingFile(index: number): void {
    pendingFiles = pendingFiles.filter((_, i) => i !== index);
    attachError = null;
    attachUpgradeUrl = null;
  }

  function namePastedFile(file: File): File {
    const renamed = namePastedImageFile(file, pasteCounter + 1);
    if (renamed !== file) pasteCounter += 1;
    return renamed;
  }

  function onComposerPaste(e: ClipboardEvent): void {
    if (!onuploadfiles) return;
    const files = filesFromDataTransfer(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    addPendingFiles(files.map(namePastedFile));
  }

  async function resolveAttachmentUrl(
    item: FileAttachmentModel,
  ): Promise<string | null> {
    if (item.previewUrl) return item.previewUrl;
    const companyUid = item.companyUid || vaultCompanyUid || "";
    if (!onpresign || !companyUid || !item.vaultPath) return null;
    return onpresign(companyUid, item.vaultPath);
  }

  /**
   * "Also send to #channel" (scene home-thread). Off by default and reset
   * after each send, matching Slack: a thread reply is echoed to the channel
   * only when the sender asks for it on that reply.
   */
  let alsoSendToChannel = $state(false);
  const canAlsoSend = $derived(scope === "channel" && Boolean(channelId?.trim()));
  const channelLabel = $derived(
    (channelName?.trim() || "channel").replace(/^#/, ""),
  );

  async function deliver(
    body: string,
    attachments?: ChatAttachmentWire[],
    mentions?: MentionTarget[],
  ): Promise<void> {
    await api.sendReply({
      scope,
      rootEventId,
      body,
      ...(scope === "channel" && channelId ? { channelId } : {}),
      ...(scope === "dm" && withPersonUid ? { withPersonUid } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    });
  }

  /**
   * A decision-block button in the thread was clicked. A concrete option sends
   * its label as a reply; "Other…" focuses the composer for a free-text answer.
   */
  async function handleDecision(detail: {
    questionId?: string;
    option: DecisionOption | null;
  }): Promise<void> {
    if (!detail.option) {
      composerEl?.focus();
      return;
    }
    await send(detail.option.label);
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
        // raw-error-ok: formatComposerSendError maps it to plain copy
        const raw = err instanceof Error ? err.message.trim() : "";
        attachError = formatComposerSendError(raw, true);
        attachUpgradeUrl = uploadErrorUpgradeUrl(err);
        sending = false;
        return;
      }
    }
    const mentions = mentionPayloadTargets(
      mentionsPresentInBody(text, selectedMentions),
    );
    const localId = `local-${rootEventId}-${++localSeq}`;
    const optimistic: LocalReply = {
      eventId: localId,
      fromDisplayName: selfDisplayName?.trim() || "You",
      body: text,
      createdAt: new Date().toISOString(),
      direction: "out",
      rootEventId,
      sendStatus: "sending",
      mentions,
      ...(attachments ? { attachments } : {}),
    };
    seenIds.add(localId);
    replies = [...replies, optimistic];
    draft = "";
    selectedMentions = [];
    mentionHighlight = 0;
    pendingFiles = [];
    attachError = null;
    attachUpgradeUrl = null;
    const echoToChannel = alsoSendToChannel && canAlsoSend;
    alsoSendToChannel = false;
    try {
      await deliver(text, attachments, mentions);
      replies = replies.map((row) =>
        row.eventId === localId ? { ...row, sendStatus: undefined } : row,
      );
      if (echoToChannel && channelId && text) {
        // The reply landed; the channel echo is best-effort and never turns a
        // delivered reply into a failed row.
        void api
          .sendChannelMessage({
            channelId,
            body: text,
            ...(mentions.length > 0 ? { mentions } : {}),
          })
          .catch((err) => {
            console.error("ReplyPanel: also-send to channel failed", err);
          });
      }
      emitCount(replyCount + 1, replies);
      startThinkingForMentions(mentions);
      startThinkingForThreadAgent(mentions);
    } catch (err) {
      const failure = describeSendFailure(err, mentions);
      replies = replies.map((row) =>
        row.eventId === localId
          ? { ...row, sendStatus: "failed", ...failure }
          : row,
      );
      agentThinking = [];
    } finally {
      sending = false;
    }
  }

  /**
   * Turn a thrown send error into the row's human reason plus whether a retry
   * could ever work. The adapter throws `[CODE] message`, so the code survives
   * all the way here — dropping it (the old bare `catch {}`) left the user with
   * "Failed — tap to retry" on a 4xx that no retry can fix.
   */
  function describeSendFailure(
    err: unknown,
    mentions: readonly MentionTarget[],
  ): { sendError: string; sendFatal: boolean } {
    // raw-error-ok: formatComposerSendError maps it to plain copy
    const raw = err instanceof Error ? err.message.trim() : "";
    return {
      sendError: formatComposerSendError(
        raw,
        false,
        mentions.map((mention) => mention.displayName),
      ),
      sendFatal: isTerminalSendError(raw),
    };
  }

  async function retrySend(eventId: string): Promise<void> {
    const failed = replies.find(
      (row) => row.eventId === eventId && row.sendStatus === "failed",
    );
    if (!failed || failed.sendFatal || sending) return;
    sending = true;
    replies = replies.map((row) =>
      row.eventId === eventId
        ? {
            ...row,
            sendStatus: "sending",
            sendError: undefined,
            sendFatal: undefined,
          }
        : row,
    );
    const retryMentions = mentionPayloadTargets(
      (failed.mentions ?? []).map((row) => ({
        participantUid: row.participantUid,
        participantType: storedMentionType(row),
        displayName: row.displayName,
      })),
    );
    try {
      await deliver(
        failed.body ?? "",
        (failed.attachments ?? undefined) as ChatAttachmentWire[] | undefined,
        retryMentions,
      );
      replies = replies.map((row) =>
        row.eventId === eventId
          ? {
              ...row,
              sendStatus: undefined,
              sendError: undefined,
              sendFatal: undefined,
            }
          : row,
      );
      emitCount(replyCount + 1, replies);
      startThinkingForMentions(retryMentions);
    } catch (err) {
      const failure = describeSendFailure(err, retryMentions);
      replies = replies.map((row) =>
        row.eventId === eventId
          ? { ...row, sendStatus: "failed", ...failure }
          : row,
      );
      agentThinking = [];
    } finally {
      sending = false;
    }
  }

  function onComposerKey(e: KeyboardEvent): void {
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
        e.stopPropagation();
        draft = draft.replace(/(^|\s)@([^\s@]*)$/, "$1");
        return;
      }
    }
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
      agentThinking = [];
      void load();
    });
    return () => onactivethreadchange?.(null);
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

  function onReplyNew(root: string, eventId?: string): void {
    if (root !== rootEventId) return;
    const id = (eventId ?? "").trim();
    if (id && seenIds.has(id)) return;
    void load();
  }

  /** The agent says it is still working in THIS thread: keep its row up. */
  function onAgentStatus(wake: AgentStatusWake): void {
    if (scope !== "channel" || !channelId || wake.channelId !== channelId) return;
    if (wake.threadRoot !== rootEventId) return;
    const thread = [...(root ? [root] : []), ...replies];
    agentThinking = applyAgentStatus(
      agentThinking,
      wake,
      agentDisplayName(wake.agentUid, thread, { liveNames: displayNameByUid }),
      thread,
      Date.now(),
    );
  }

  $effect(() => {
    if (wakes) return wakes.on("agent:status", onAgentStatus);
    return subscribeAgentStatus(onAgentStatus);
  });

  $effect(() => {
    if (wakes) {
      return wakes.on("reply:new", (payload) => {
        onReplyNew(payload.rootEventId, payload.eventId);
      });
    }
    return subscribeReplyNew((payload) => {
      onReplyNew(payload.rootEventId, payload.eventId);
    });
  });
</script>

{#snippet replyBodyText(msg: ConversationMessageWire, text: string)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="reply-md msg-body"
    class:msg-body-jumbo={isJumboEmojiBody(text)}
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
    {#if isHeavyMessageBody(text)}
      <PlainMessageBody body={text} />
    {:else}
      {@html applyMentionMarkup(
        renderMessageBodyMarkdown(text),
        storedMentions(msg),
      )}
    {/if}
  </div>
{/snippet}

{#snippet replyContent(msg: ConversationMessageWire, rich: ExtractedRichContent, withArtifacts: boolean)}
  {#if rich.text.trim()}
    {@render replyBodyText(msg, rich.text)}
  {/if}
  {#if rich.rich}
    <RichMessageContent
      content={rich.rich}
      ondecision={handleDecision}
      {answeredQuestionIds}
      {answeredChoices}
    />
  {/if}
  {#if withArtifacts && msg.details?.trim()}
    <ArtifactCard
      kind="details"
      text={msg.details}
      eventId={msg.eventId}
      onopen={onopenartifact}
    />
  {/if}
  {#if withArtifacts && msg.prompt?.trim()}
    <ArtifactCard
      kind="prompt"
      text={msg.prompt}
      eventId={msg.eventId}
      onopen={onopenartifact}
    />
  {/if}
  <MessageAttachments
    {previewCache}
    {vaultCompanyUid}
    attachments={parseMessageAttachments(msg)}
    onopen={onopenattachment}
    resolveUrl={resolveAttachmentUrl}
    {onreleaseurl}
  />
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
  class="reply-panel"
  aria-label="Thread"
  data-testid="reply-panel"
  data-root-event-id={rootEventId}
  onclick={onBodyLinkActivate}
  onauxclick={onBodyLinkActivate}
  oncontextmenu={onBodyLinkActivate}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") onBodyLinkActivate(e);
  }}
>
  <header class="reply-header">
    <div class="reply-heading">
      <h2 class="reply-title" data-testid="reply-panel-title">Thread</h2>
      {#if canAlsoSend && channelName?.trim()}
        <span class="reply-sub" data-testid="reply-panel-sub">#{channelLabel}</span>
      {/if}
    </div>
    <button
      class="reply-close"
      type="button"
      data-testid="reply-panel-close"
      aria-label="Close"
      title="Close"
      onclick={onclose}
    >
      <RailIcon name="x" size={14} />
    </button>
  </header>

  <div class="reply-body">
    <div class="reply-list" data-testid="reply-panel-list">
      <!-- The thread's first message scrolls with its replies, so a long one
           never squeezes the conversation into a sliver under it. -->
      <div class="reply-root" data-testid="reply-panel-root">
        {#if root}
          {@const rootId = root.eventId}
          {@const rootRich = richContentForMessage(root)}
          {@const rootForwarded = parseForwardedFrom(root.forwardedFrom)}
          {@const rootForwardNote = rootForwarded ? forwardNoteText(root.forwardNote) : ""}
          <!-- The picture opens the author's profile, as the name does. -->
          {#if onopenprofile && (root.fromPersonUid ?? "").trim()}
            <button
              type="button"
              class="reply-avatar reply-avatar-btn"
              data-testid="reply-avatar-open"
              aria-label={`Open ${messageAuthor(root)}'s profile`}
              onclick={() => openAuthorProfile(root)}
            ><IdentityMark
              kind={isAgent(root) ? "agent" : "person"}
              label={messageAuthor(root)}
              avatarUrl={authorAvatarUrl(root.fromPersonUid, avatarByUid)}
              agentUid={root.fromPersonUid}
              personUid={isAgent(root) ? null : root.fromPersonUid}
              size="regular"
            /></button>
          {:else}
            <span class="reply-avatar" aria-hidden="true">
              <IdentityMark
              kind={isAgent(root) ? "agent" : "person"}
              label={messageAuthor(root)}
              avatarUrl={authorAvatarUrl(root.fromPersonUid, avatarByUid)}
              agentUid={root.fromPersonUid}
              personUid={isAgent(root) ? null : root.fromPersonUid}
              size="regular"
            />
            </span>
          {/if}
          <div class="reply-col">
            <div class="reply-meta">
              {#if onopenprofile && (root.fromPersonUid ?? "").trim()}
                <button
                  type="button"
                  class="reply-root-author reply-author-btn"
                  data-testid="reply-root-author-open"
                  onclick={() => openAuthorProfile(root)}
                  >{messageAuthor(root)}</button
                >
              {:else}
                <span class="reply-root-author">{messageAuthor(root)}</span>
              {/if}
              <span class="reply-time">{formatTime(root.createdAt)}</span>
            </div>
            <!-- The box the hover bar hangs off: the body only, never the
                 reaction row, so the bar opens 4px under the message it
                 belongs to, the same as the main timeline. -->
            <div class="reply-main">
              <div class="reply-root-body">
                {#if rootForwarded}
                  {#if rootForwardNote}
                    {@render replyBodyText(root, rootForwardNote)}
                  {/if}
                  <ForwardedBlock
                    forwardedFrom={rootForwarded}
                    omittedAttachments={parseOmittedAttachments(root.omittedAttachments)}
                  >
                    {@render replyContent(root, rootRich, true)}
                  </ForwardedBlock>
                {:else}
                  {@render replyContent(root, rootRich, true)}
                {/if}
              </div>
              <div
                class="reply-quick-react reply-quick-react-root"
                role="group"
                aria-label="Message actions"
              >
                {#each QUICK_REACT_EMOJI as emoji (emoji)}
                  <button
                    type="button"
                    class="reply-quick-react-btn"
                    onclick={() => toggle(rootId, emoji)}
                    aria-label={`React with ${emoji}`}
                  >
                    {emoji}
                  </button>
                {/each}
                <span class="reply-quick-react-picker-wrap">
                  <button
                    type="button"
                    class="reply-quick-react-btn reply-quick-react-more"
                    aria-label="Add a reaction"
                    title="Add a reaction"
                    aria-haspopup="menu"
                    aria-expanded={reactPickerFor === rootId}
                    onclick={() =>
                      (reactPickerFor = reactPickerFor === rootId ? null : rootId)}
                  >
                    <RailIcon name="plus" size={12} />
                  </button>
                  {#if reactPickerFor === rootId}
                    <EmojiPicker
                      onpick={(emoji) => {
                        reactPickerFor = null;
                        toggle(rootId, emoji);
                      }}
                      onclose={() => (reactPickerFor = null)}
                    />
                  {/if}
                </span>
                <button
                  type="button"
                  class="reply-quick-react-btn reply-quick-copy"
                  data-testid="reply-copy-id"
                  aria-label="Copy message ID"
                  title="Copy ID"
                  onclick={() => copyId(rootId)}
                >
                  {copiedKey === `id:${rootId}` ? "Copied" : "Copy ID"}
                </button>
                {#if linkConversationId && linkCompanyUid}
                  <button
                    type="button"
                    class="reply-quick-react-btn reply-quick-copy"
                    data-testid="reply-copy-link"
                    aria-label="Copy message link"
                    title="Copy link"
                    onclick={() => copyLink(rootId)}
                  >
                    {copiedKey === `link:${rootId}` ? "Copied" : "Copy link"}
                  </button>
                {/if}
              </div>
            </div>
            {#if reactionsFor(rootId).length > 0}
              <ReactionBar
                        {selfPersonUid}
                        {displayNameByUid}
                messageId={rootId}
                reactions={reactionsFor(rootId)}
                ontoggle={toggle}
                compact
              />
            {/if}
            <!-- The count divider separates the root from its replies, so an
                 empty thread draws none: a lone "0 REPLIES" rule under the
                 root read as a broken label, not as information. -->
            {#if replyCount > 0}
              <span class="reply-root-label" data-testid="reply-count-divider">
                {replyCount}
                {replyCount === 1 ? "reply" : "replies"}
              </span>
            {/if}
          </div>
        {:else if loading}
          <p class="reply-status" role="status">Loading replies…</p>
        {:else if loadError}
          <p class="reply-status reply-error" role="alert">{loadError}</p>
        {/if}
      </div>
      {#if loading && replies.length === 0 && root}
        <p class="reply-status" role="status">Loading replies…</p>
      {:else if loadError && replies.length === 0 && root}
        <p class="reply-status reply-error" role="alert">{loadError}</p>
      {:else if visibleReplies.length > 0}
        <!-- No "No replies yet" line (and no count divider) for an empty
             thread: the open composer already invites the first reply. -->
        {#each visibleReplies as msg, index (msg.eventId)}
          {@const replyRich = richContentForMessage(msg)}
          {@const replyForwarded = parseForwardedFrom(msg.forwardedFrom)}
          {@const replyForwardNote = replyForwarded ? forwardNoteText(msg.forwardNote) : ""}
          <div
            class="reply-row"
            class:reply-row-last={index === visibleReplies.length - 1}
            data-testid="reply-panel-message"
            data-event-id={msg.eventId}
            data-send-status={msg.sendStatus ?? ""}
          >
            <!-- The picture opens the author's profile, as the name does. -->
            {#if onopenprofile && (msg.fromPersonUid ?? "").trim()}
              <button
                type="button"
                class="reply-avatar reply-avatar-btn"
                data-testid="reply-avatar-open"
                aria-label={`Open ${messageAuthor(msg)}'s profile`}
                onclick={() => openAuthorProfile(msg)}
              ><IdentityMark
                kind={isAgent(msg) ? "agent" : "person"}
                label={messageAuthor(msg)}
                avatarUrl={authorAvatarUrl(msg.fromPersonUid, avatarByUid)}
                agentUid={msg.fromPersonUid}
                personUid={isAgent(msg) ? null : msg.fromPersonUid}
                size="regular"
              /></button>
            {:else}
              <span class="reply-avatar" aria-hidden="true">
                <IdentityMark
                kind={isAgent(msg) ? "agent" : "person"}
                label={messageAuthor(msg)}
                avatarUrl={authorAvatarUrl(msg.fromPersonUid, avatarByUid)}
                agentUid={msg.fromPersonUid}
                personUid={isAgent(msg) ? null : msg.fromPersonUid}
                size="regular"
              />
              </span>
            {/if}
            <div class="reply-col">
              <div class="reply-meta">
                {#if onopenprofile && (msg.fromPersonUid ?? "").trim()}
                  <button
                    type="button"
                    class="reply-author reply-author-btn"
                    data-testid="reply-author-open"
                    onclick={() => openAuthorProfile(msg)}
                    >{messageAuthor(msg)}</button
                  >
                {:else}
                  <span class="reply-author">{messageAuthor(msg)}</span>
                {/if}
                <span class="reply-time">{formatTime(msg.createdAt)}</span>
              </div>
              <div class="reply-main">
                {#if replyForwarded}
                  {#if replyForwardNote}
                    {@render replyBodyText(msg, replyForwardNote)}
                  {/if}
                  <ForwardedBlock
                    forwardedFrom={replyForwarded}
                    omittedAttachments={parseOmittedAttachments(msg.omittedAttachments)}
                  >
                    {@render replyContent(msg, replyRich, true)}
                  </ForwardedBlock>
                {:else}
                  {@render replyContent(msg, replyRich, false)}
                {/if}
                {#if !msg.eventId.startsWith("local-")}
                  <div
                    class="reply-quick-react"
                    role="group"
                    aria-label="Message actions"
                  >
                    {#each QUICK_REACT_EMOJI as emoji (emoji)}
                      <button
                        type="button"
                        class="reply-quick-react-btn"
                        onclick={() => toggle(msg.eventId, emoji)}
                        aria-label={`React with ${emoji}`}
                      >
                        {emoji}
                      </button>
                    {/each}
                    <span class="reply-quick-react-picker-wrap">
                      <button
                        type="button"
                        class="reply-quick-react-btn reply-quick-react-more"
                        aria-label="Add a reaction"
                        title="Add a reaction"
                        aria-haspopup="menu"
                        aria-expanded={reactPickerFor === msg.eventId}
                        onclick={() =>
                          (reactPickerFor =
                            reactPickerFor === msg.eventId ? null : msg.eventId)}
                      >
                        <RailIcon name="plus" size={12} />
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
                      class="reply-quick-react-btn reply-quick-copy"
                      data-testid="reply-copy-id"
                      aria-label="Copy message ID"
                      title="Copy ID"
                      onclick={() => copyId(msg.eventId)}
                    >
                      {copiedKey === `id:${msg.eventId}` ? "Copied" : "Copy ID"}
                    </button>
                    {#if linkConversationId && linkCompanyUid}
                      <button
                        type="button"
                        class="reply-quick-react-btn reply-quick-copy"
                        data-testid="reply-copy-link"
                        aria-label="Copy message link"
                        title="Copy link"
                        onclick={() => copyLink(msg.eventId)}
                      >
                        {copiedKey === `link:${msg.eventId}` ? "Copied" : "Copy link"}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
              {#if !msg.eventId.startsWith("local-") && reactionsFor(msg.eventId).length > 0}
                <ReactionBar
                    {selfPersonUid}
                    {displayNameByUid}
                  messageId={msg.eventId}
                  reactions={reactionsFor(msg.eventId)}
                  ontoggle={toggle}
                  compact
                />
              {/if}
              {#if msg.sendStatus === "sending"}
                <span class="reply-send-state" role="status">Sending…</span>
              {:else if msg.sendStatus === "failed" && msg.sendFatal}
                <span
                  class="reply-send-state failed"
                  data-testid="reply-panel-send-error"
                  role="status"
                >
                  {msg.sendError ?? "Couldn't send this reply."}
                </span>
              {:else if msg.sendStatus === "failed"}
                <button
                  type="button"
                  class="reply-send-state failed"
                  data-testid="reply-panel-retry"
                  onclick={() => void retrySend(msg.eventId)}
                ><RailIcon name="refresh" />
                  {msg.sendError
                    ? `${msg.sendError} Tap to retry.`
                    : "Failed — tap to retry"}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Live rows sit between the list and the composer, so they carry the
         list's horizontal inset themselves: the 18px avatar centres under the
         32px avatar column of the rows above, and a gap keeps the last row
         off the composer's border. -->
    <div class="reply-live">
      <AgentThinkingRow entries={agentThinking} />
      <AgentTaskStrip {tasks} />
    </div>

    {#if canAlsoSend}
      <label class="reply-also" data-testid="reply-panel-also-send">
        <input
          type="checkbox"
          role="switch"
          class="reply-also-input"
          aria-checked={alsoSendToChannel}
          bind:checked={alsoSendToChannel}
        />
        <span class="reply-also-switch" aria-hidden="true"></span>
        Also send to #{channelLabel}
      </label>
    {/if}
    <div class="reply-composer">
      {#if showMentionPicker}
        <MentionPicker
          hits={mentionHits}
          highlight={mentionHighlight}
          {localBots}
          onpick={applyMention}
        />
      {/if}
      {#if pendingFiles.length > 0 || attachError}
        <ComposerPendingAttachments
          files={pendingFiles}
          error={attachError}
          upgradeUrl={attachUpgradeUrl}
          onupgrade={onopenurl}
          testid="reply-panel-pending"
          onremove={removePendingFile}
        />
      {/if}
      <textarea
        class="reply-input"
        rows="2"
        placeholder="Reply…"
        aria-label="Reply"
        data-testid="reply-panel-composer"
        bind:this={composerEl}
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
            <RailIcon name="paperclip" size={15} />
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
          <RailIcon name="paper-plane-tilt" size={13} />
        </button>
      </div>
    </div>
  </div>
  {#if linkMenu}
    <LinkContextMenu
      menu={linkMenu}
      {onopenurl}
      onclose={() => (linkMenu = null)}
    />
  {/if}
</aside>

<style>
  .reply-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    height: 100%;
    /* The rail's own ground (`--side-bg`), so the thread reads as a side
       surface of the shell rather than a lighter card laid over it. No
       border: the host's `.reply-column` owns the divider, and a second
       hairline here stacked into a heavy 2px rule. */
    background: var(--side-bg, var(--surface-panel, var(--v4-ground, #161618)));
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  /* No rule under the header: the caption and the close button sit on the
     panel's ground, and the list starts right under them. */
  .reply-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 16px 18px 0;
    flex-shrink: 0;
  }

  /* The title keeps the owner's recorded Messages type (AUDIT-2-06,
     chat/messages-type-exception.ts: 15px / 700); the PR #772 10px mono
     caption is not applied on the beta. The restyle keeps everything else:
     no rule under the header, the 24px close, the panel ground. */
  .reply-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-heading {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .reply-sub {
    font-size: 12px;
    color: var(--t3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reply-also {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 12px 8px;
    font-size: 12px;
    color: var(--t2);
    cursor: pointer;
    user-select: none;
  }

  .reply-also-input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    pointer-events: none;
  }

  .reply-also-switch {
    position: relative;
    flex: none;
    width: 26px;
    height: 16px;
    border-radius: 8px;
    background: var(--v4-control-border, var(--line));
    transition: background-color 0.12s ease;
  }

  .reply-also-switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--t1);
    opacity: 0.7;
    transition: transform 0.12s ease;
  }

  .reply-also-input:checked + .reply-also-switch {
    background: var(--ice);
  }

  .reply-also-input:checked + .reply-also-switch::after {
    transform: translateX(10px);
    opacity: 1;
  }

  .reply-also-input:focus-visible + .reply-also-switch {
    outline: 2px solid var(--ice);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .reply-also-switch,
    .reply-also-switch::after {
      transition: none;
    }
  }

  /* 24px icon target, quiet until hovered — the shell's icon-button size. */
  .reply-close {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    line-height: 1;
    cursor: pointer;
    transition:
      color 0.12s,
      background 0.12s;
  }

  .reply-close:hover,
  .reply-close:focus-visible {
    color: var(--t1);
    background: var(--hover, color-mix(in srgb, var(--t1) 6%, transparent));
    outline: none;
  }

  /* Same geometry as the replies under it and the main chat's `.dm-msg`:
     32px avatar on a 12px gutter, and no boxed-off border — the reply-count
     divider below is the only rule between the root and its replies. */
  .reply-root {
    position: relative;
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 12px 8px 4px;
  }

  /* Hover, keyboard focus, or the emoji picker open. Not `:focus-within`: a
     mouse click on a bar button left focus inside the row, which pinned the
     bar over it after the pointer had moved on. */
  .reply-root:hover .reply-quick-react-root,
  .reply-root:has(:global(:focus-visible)) .reply-quick-react-root,
  .reply-quick-react-root:has(:global(:focus-visible)),
  .reply-quick-react-root:has([aria-expanded="true"]) {
    opacity: 1;
    pointer-events: auto;
  }

  /* Touch input has no hover state, so a hover-only toolbar is unreachable. */
  @media (hover: none) {
    .reply-quick-react-root {
      opacity: 1;
      pointer-events: auto;
    }
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
    font-size: 14px;
    font-weight: 600;
    line-height: var(--msg-author-line-height, 1.3);
    color: var(--t1);
  }

  button.reply-author-btn {
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }

  button.reply-author-btn:hover {
    opacity: 0.7;
  }

  button.reply-author-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
    border-radius: 4px;
  }

  /* Clickable @mentions inside a thread message body. */
  .reply-md :global(.inline-mention) {
    background: rgba(99, 102, 241, 0.2);
    border-radius: 3px;
    color: var(--vio-ink, #c7d2fe);
    font-weight: 700;
    padding: 0 2px;
  }

  .reply-md :global(.inline-mention[data-person-uid]) {
    cursor: pointer;
  }

  .reply-md :global(.inline-mention[data-person-uid]:hover) {
    opacity: 0.7;
  }

  .reply-md :global(a),
  .reply-md :global(a:visited) {
    color: var(--message-markdown-link);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
    text-underline-offset: 0.125rem;
  }

  .reply-md :global(a:hover) {
    color: color-mix(in srgb, var(--message-markdown-link) 88%, var(--t1));
    text-decoration-color: currentColor;
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
    --message-markdown-link: var(--vio-ink, var(--accent, #e0c4fe));
    min-width: 0;
    margin: 0;
    /* Match the timeline reading size (shared token, message-row.css). */
    font-family: var(--msg-body-font-family, var(--font-ui));
    font-size: var(--msg-body-font-size, 15px);
    line-height: var(--msg-body-line-height, 1.7);
    color: var(--t1, var(--message-markdown-text));
    overflow-wrap: anywhere;
  }

  /* Same first/last/p collapse as .dm-bubble-body — UA <p> margin was the
     extra name→body line in the thread panel. */
  .reply-md > :global(:first-child) {
    margin-top: 0;
  }

  .reply-md > :global(:last-child) {
    margin-bottom: 0;
  }

  .reply-md :global(p) {
    margin: var(--msg-body-p-margin, 0.375rem 0);
    color: inherit;
  }

  /* Hairline / caption / hairline, drawn once. The root used to carry a
     border-bottom AND this label a border-top, two rules a few pixels apart
     around one caption. */
  .reply-root-label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 0 14px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--t3);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .reply-root-label::before,
  .reply-root-label::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
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
    /* 10px list inset + 8px row padding puts every avatar, the root's
       included, on the header caption's 18px edge. */
    padding: 0 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* 32px avatar on a 12px gutter, the main chat's `.dm-msg` geometry. */
  .reply-row {
    position: relative;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    padding: 5px 8px;
    border-radius: 6px;
  }

  .reply-avatar {
    display: grid;
    place-items: start center;
    flex: 0 0 32px;
    width: 32px;
    min-height: 1px;
    padding-top: var(--msg-avatar-pad-top, 2px);
  }

  /* The picture as a button: no chrome, the same box as the plain one. */
  button.reply-avatar-btn {
    margin: 0;
    padding: var(--msg-avatar-pad-top, 2px) 0 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    align-self: flex-start;
  }

  button.reply-avatar-btn:focus-visible {
    outline: 2px solid var(--v4-focus, var(--t2));
    outline-offset: 2px;
    border-radius: 50%;
  }

  .reply-row:hover {
    background: color-mix(in srgb, var(--t1) 4%, transparent);
  }

  /* The box the hover bar hangs off: the message body only, never the
     reaction row, so the bar lands on the bottom edge of the content it
     belongs to. */
  .reply-main {
    position: relative;
    align-self: stretch;
    min-width: 0;
  }

  /* Hover quick-react toolbar, placed like the main chat's `.dm-quick-react`:
     an opaque bar that takes no layout space and opens 4px under the
     message's right edge. At `top: -12px` it sat over the message above and
     read as belonging to that one. */
  .reply-quick-react {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 1px;
    margin-top: 4px;
    padding: 2px;
    border: 1px solid var(--panel-border, var(--line));
    border-radius: 8px;
    background-color: var(--v4-ground, #1c1c1f);
    background-image: linear-gradient(var(--panel-bg), var(--panel-bg));
    box-shadow: var(--panel-shadow, 0 8px 24px rgba(0, 0, 0, 0.4));
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }

  /* Bridges the 4px offset so the pointer never crosses dead space on its way
     from the message to the bar (the bar hides the moment hover drops). */
  .reply-quick-react::before {
    content: "";
    position: absolute;
    inset: -6px -4px -4px;
    z-index: -1;
  }

  /* The last reply has no room under it before the list's scroll edge: a bar
     hanging below would be clipped and, even at rest, stretch the scroll
     height. It opens 4px above the body instead. */
  .reply-row-last .reply-quick-react {
    top: auto;
    bottom: 100%;
    margin: 0 0 4px;
  }

  .reply-row-last .reply-quick-react::before {
    inset: -4px -4px -6px;
  }

  /* Same rule as the root bar above: keyboard focus only, not `:focus-within`. */
  .reply-row:hover .reply-quick-react,
  .reply-row:has(:global(:focus-visible)) .reply-quick-react,
  .reply-quick-react:has(:global(:focus-visible)),
  .reply-quick-react:has([aria-expanded="true"]) {
    opacity: 1;
    pointer-events: auto;
  }

  @media (hover: none) {
    .reply-quick-react {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .reply-quick-react-picker-wrap {
    position: relative;
    display: inline-flex;
  }

  .reply-quick-react-more {
    color: var(--t2, var(--pop-muted));
    font-weight: 600;
  }

  /* Transparent 24px targets that fill only under the pointer. A resting
     fill on every button turned one bar into a row of pressed chips. */
  .reply-quick-react-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }

  .reply-quick-react-btn:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .reply-quick-copy {
    padding: 0 8px;
    font: 500 11px/1 var(--font-ui);
  }

  .reply-col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .reply-meta {
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    margin: 0 0 var(--msg-name-body-gap, 0.1875rem);
    min-width: 0;
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
  .reply-live {
    flex: 0 0 auto;
    /* 10px list padding + 8px row padding, plus (32 - 18) / 2 so the small
       avatar centres under the message avatar column. */
    padding: 0 18px 0 25px;
  }

  .reply-live:has(:global(.agent-thinking)),
  .reply-live:has(:global(.agent-tasks)) {
    padding-bottom: 10px;
  }

  .reply-composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 0 0 auto;
    margin: 0 12px 16px;
    padding: 14px 10px 10px 16px;
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 12px;
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
    /* Same token as the thread body above — typed text and sent text match. */
    font: var(--msg-body-font, 400 15px / 1.7 var(--font-ui));
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
    /* Match the main composer's `.btn-send`: the ice INK fill with the badge
       foreground on it. The old literals were the dark theme's values, so in
       light mode the thread button stayed a pale chip with a dark arrow. */
    background: var(--ice-ink);
    color: var(--badge-fg);
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
