/**
 * Injection seams for the chat shell and inbox (US-007).
 *
 * packages/ui is platform-pure: NO Tauri imports, NO invoke, NO direct
 * fetches. Every backend interaction the desktop-alt source performed via
 * `invoke` is expressed here as a structural interface the host app
 * implements (web: on top of `@hq/platform`'s WebPlatformAdapter + hq-pro
 * REST; desktop: on top of Tauri invoke). Components receive these via props.
 *
 * Wake events (previously Tauri `listen()` channels) are delivered through
 * the ChatWakeBus seam — on web the host wires MeshClient wakes into it.
 */

import type { Channel } from "./channels";
import type { DmRequest } from "./dm-requests";
import type { ChannelDirectoryFeed } from "./channel-directory-reconciler";
import type { DmContactInput, MessageSearchResult } from "./sidebar-model";

export interface ContactsResponse {
  contacts: DmContactInput[];
}
export interface ChannelsResponse {
  channels?: Channel[];
}
export interface RequestsResponse {
  requests?: DmRequest[];
}

/** Backend seam for the chat sidebar (replaces desktop-alt invoke calls). */
export interface ChatSidebarApi {
  /** the desktop `fetch_channel_directory` command in the desktop source. */
  fetchChannelDirectory(cursor: string | null): Promise<ChannelDirectoryFeed>;
  /** the desktop `list_contacts` command. */
  listContacts(): Promise<ContactsResponse>;
  /** the desktop `list_dm_requests` command. */
  listDmRequests(): Promise<RequestsResponse>;
  /** the desktop `list_channels` command (US-021). */
  listChannels(args: {
    companyUid: string;
    includeCompanyProjects: boolean;
  }): Promise<ChannelsResponse | null>;
  /** the desktop `mark_dm_thread_read` command. */
  markDmThreadRead(withPersonUid: string): Promise<void>;
  /** the desktop `mark_channel_read` command. */
  markChannelRead(channelId: string): Promise<void>;
  /** the desktop `search_messages` command (US-013). */
  searchMessages(args: {
    q: string;
    companyUid?: string;
    limit?: number;
  }): Promise<MessageSearchResult>;
  /**
   * POST /v1/notify/channels — create a named channel. Optional: hosts
   * without a live backend omit it and the sidebar hides "New channel".
   */
  createChannel?(args: {
    name: string;
    scope: "personal" | "company";
    companyUid?: string;
  }): Promise<{ channelId: string }>;
  /** POST /v1/notify/channels/{id}/members — add a participant. */
  addChannelMember?(channelId: string, toPersonUid: string): Promise<void>;
  /** Send a message into a channel before closing or navigating compose. */
  sendChannelMessage(args: { channelId: string; body: string }): Promise<void>;
  /** Send a one-to-one DM before closing or navigating compose. */
  sendDm(args: { toPersonUid: string; body: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Conversation view (minimal MessagesShell port — channel + DM history)
// ---------------------------------------------------------------------------

/** Wire message row (subset of the desktop ChannelMessageWire / ThreadMessage). */
export interface ConversationMessageWire {
  eventId: string;
  fromPersonUid?: string | null;
  fromEmail?: string | null;
  fromDisplayName?: string | null;
  body?: string | null;
  /** Block-formatted extra body (`hq dm --details`). */
  details?: string | null;
  /** Agent-context prompt the recipient can copy (`hq dm --prompt`). */
  prompt?: string | null;
  createdAt: string;
  direction?: "in" | "out" | string;
  /** "system" for run-cards / system-event lines (parsed via channelMessageModels). */
  messageKind?: string | null;
  /** Versioned system-event envelope (run_complete card, deploy/pr lines, …). */
  systemEvent?: unknown;
  /** Cached emoji aggregates — shown before the live GET settles. */
  reactions?: Array<{
    emoji: string;
    count: number;
    reactedByMe: boolean;
  }> | null;
  /** Structured channel mentions (person or agent). */
  mentions?: Array<{
    participantUid: string;
    participantType?: string;
    displayName: string;
  }> | null;
  /** Vault-backed files hung off this message. */
  attachments?: Array<{
    id?: string | null;
    vaultPath: string;
    companyUid?: string | null;
    name: string;
    contentType?: string | null;
    sizeBytes?: number | null;
    kind?: string | null;
    previewUrl?: string | null;
  }> | null;
  /** Legacy singular attachment (hq-sync desktop). */
  attachment?: {
    vaultPath: string;
    name: string;
    sizeBytes?: number | null;
    kind?: string | null;
  } | null;
  /**
   * Reply-thread root. A non-empty value that differs from `eventId` marks
   * this row as a reply (hidden from the main timeline).
   */
  rootEventId?: string | null;
  /** Reply count on a root. Absent on old rows and on replies themselves. */
  replyCount?: number;
  /**
   * Optional last-reply timestamp. hq-pro list pages do not store this —
   * callers must not require it.
   */
  lastReplyAt?: string | null;
}

/** Channel detail + newest-first message page (desktop `fetch_channel`). */
export interface ChannelDetailResponse {
  channel?: Channel;
  messages: ConversationMessageWire[];
  nextCursor?: string | null;
}

/** Newest-first DM thread page (desktop `fetch_dm_thread`). */
export interface DmThreadResponse {
  messages: ConversationMessageWire[];
  nextCursor?: string | null;
}

/** Reply-thread partition. Distinct from GET /v1/notify/thread (1:1 DM list). */
export type ReplyThreadScope = "dm" | "channel";

export interface FetchReplyThreadArgs {
  scope: ReplyThreadScope;
  rootEventId: string;
  withPersonUid?: string;
  channelId?: string;
}

export interface SendReplyArgs {
  scope: ReplyThreadScope;
  rootEventId: string;
  body: string;
  withPersonUid?: string;
  channelId?: string;
  attachments?: Array<{
    vaultPath: string;
    name: string;
    sizeBytes?: number | null;
    kind?: string | null;
  }>;
}

/** GET /v1/notify/threads (plural) — root + oldest-first replies. */
export interface ReplyThreadResponse {
  scope: ReplyThreadScope;
  root: ConversationMessageWire | null;
  replies: ConversationMessageWire[];
  replyCount: number;
}

/**
 * Derive reply-thread scope from a conversation row.
 * channelId present → channel (chat, project, AND group DMs — kind may be
 * "group" but they are CHAN_MSG).
 * kind==="dm" && personUid && !channelId → dm.
 * Never use kind==="dm" alone.
 */
export function replyScopeForRow(
  row:
    | {
        kind?: string | null;
        channelId?: string | null;
        personUid?: string | null;
      }
    | null
    | undefined,
): ReplyThreadScope | null {
  if (!row) return null;
  const channelId = row.channelId?.trim() ?? "";
  if (channelId) return "channel";
  const personUid = row.personUid?.trim() ?? "";
  if (row.kind === "dm" && personUid) return "dm";
  return null;
}

/** Backend seam for the conversation view (channel + DM history and sends). */
export interface ConversationApi {
  /** the desktop `fetch_channel` command — windowed newest-first page. */
  fetchChannel(args: {
    channelId: string;
    limit?: number;
    cursor?: string | null;
    /** Exclusive ISO8601 lower bound — only messages after this instant. */
    since?: string | null;
  }): Promise<ChannelDetailResponse>;
  /** the desktop `send_channel_message` command. */
  sendChannelMessage(args: {
    channelId: string;
    body: string;
    mentions?: Array<{
      participantUid: string;
      participantType: "human" | "agent";
      displayName: string;
    }>;
    attachments?: Array<{
      id: string;
      vaultPath: string;
      companyUid: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      kind: "image" | "file";
    }>;
  }): Promise<void>;
  /** the desktop `fetch_dm_thread` command — newest-first page. */
  fetchDmThread(args: {
    withPersonUid: string;
    limit?: number;
  }): Promise<DmThreadResponse>;
  /** the desktop `send_dm` command. */
  sendDm(args: {
    toPersonUid: string;
    body: string;
    attachments?: Array<{
      id: string;
      vaultPath: string;
      companyUid: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      kind: "image" | "file";
    }>;
  }): Promise<void>;
  /**
   * GET /v1/notify/threads — must not collide with fetchDmThread
   * (GET /v1/notify/thread).
   */
  fetchReplyThread(args: FetchReplyThreadArgs): Promise<ReplyThreadResponse>;
  /**
   * POST a reply with rootEventId. Cache-first: do not GET the full reply
   * thread after send.
   */
  sendReply(args: SendReplyArgs): Promise<void>;
}

/** Backend seam for the notifications feed (replaces invoke calls). */
export interface NotificationsApi {
  /** the desktop `fetch_notifications` command. */
  fetchNotifications(args: {
    limit: number;
    cursor: string | null;
    unreadOnly: boolean;
  }): Promise<unknown>;
  /** the desktop `ack_notification` command. */
  ackNotification(id: string): Promise<void>;
  /** the desktop `read_all_notifications` command. */
  readAllNotifications(): Promise<void>;
  /** the desktop `run_notification_action` command. */
  runNotificationAction(args: {
    id: string;
    actionKind: string;
    actionRef: string | null;
  }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Wake bus — replaces Tauri `listen()`/`emit()` event channels.
// ---------------------------------------------------------------------------

export interface ChatWakeEvents {
  /** New message in a channel — ids only; fetch that slice, not the inbox. */
  "channel:new-message": {
    channelId: string;
    eventId?: string;
    createdAt?: string;
    fromPersonUid?: string;
    unread?: number;
  };
  /** A channel row changed shape. */
  "channel:updated": Channel;
  /** Unread rollup changed — reconcile the directory. */
  "channel:unread-changed": void;
  /** Per-pair DM unreads from the inbox rollup. */
  "dm:pair-unreads": {
    pairUnreads?: Array<{
      withPersonUid: string;
      lastReadAt?: string | null;
      unreadCount: number;
    }>;
    /** When true, unreadCount is a delta to add, not an absolute replace. */
    delta?: boolean;
  };
  /** A 1:1 DM landed — ids only. Rail bumps unread when that pair is not open. */
  "dm:new-message": {
    fromPersonUid: string;
    eventId?: string;
    createdAt?: string;
    direction?: "in" | "out";
  };
  /** Incoming connection request. */
  "dm:request-new": DmRequest;
  /** A connection request was resolved. */
  "dm:request-update": { pairKey: string };
  /** Mesh socket state — arm directory safety poll only when not connected. */
  "mesh:connection": {
    state:
      | "idle"
      | "connecting"
      | "connected"
      | "reconnecting"
      | "paused-hidden"
      | "closed";
  };
  /** Run cursor catch-up (directory delta + open timeline `since`). */
  "mesh:catchup": { reason: "connect" | "focus" };
  /**
   * A reply landed (hq-pro `type:"thread"`). Ids only — never a body.
   * Not named `thread:` (that collides with work-mesh).
   */
  "reply:new": ReplyNewWake;
}

/** Ids-only reply doorbell. Hosts re-fetch; they must not payload-apply. */
export interface ReplyNewWake {
  rootEventId: string;
  eventId: string;
  scope: ReplyThreadScope;
  channelId?: string;
  withPersonUid?: string;
}

function trimmedWakeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True when this doorbell belongs to the open conversation row. */
export function replyNewMatchesConversation(
  wake: ReplyNewWake,
  row:
    | {
        kind?: string | null;
        channelId?: string | null;
        personUid?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!row) return false;
  if (wake.scope === "channel") {
    const channelId = row.channelId?.trim() ?? "";
    return Boolean(channelId) && channelId === (wake.channelId ?? "").trim();
  }
  const personUid = row.personUid?.trim() ?? "";
  return Boolean(personUid) && personUid === (wake.withPersonUid ?? "").trim();
}

/**
 * Increment the matching root's visible replyCount. Does not insert the
 * reply as a timeline row and does nothing when the root is not in `messages`
 * (conversation not open — do not invent sidebar unread).
 */
export function bumpRootReplyCount<
  T extends { eventId: string; replyCount?: number },
>(messages: readonly T[], rootEventId: string): T[] {
  const root = trimmedWakeId(rootEventId);
  if (!root) return messages.slice();
  let changed = false;
  const next = messages.map((row) => {
    if (row.eventId !== root) return row;
    changed = true;
    return { ...row, replyCount: (row.replyCount ?? 0) + 1 };
  });
  return changed ? next : messages.slice();
}

export type ChatWakeEventName = keyof ChatWakeEvents;

/** Subscription seam. Returns an unsubscribe function. */
export interface ChatWakeBus {
  on<K extends ChatWakeEventName>(
    event: K,
    handler: (payload: ChatWakeEvents[K]) => void,
  ): () => void;
  emit?<K extends ChatWakeEventName>(
    event: K,
    payload: ChatWakeEvents[K],
  ): void;
}

const replyNewListeners = new Set<(payload: ReplyNewWake) => void>();

/** Subscribe to every bus's `reply:new` emit (ReplyPanel lives without a parent wire). */
export function subscribeReplyNew(
  handler: (payload: ReplyNewWake) => void,
): () => void {
  replyNewListeners.add(handler);
  return () => {
    replyNewListeners.delete(handler);
  };
}

/** Simple in-memory bus hosts can use to bridge MeshClient wakes to the UI. */
export function createChatWakeBus(): ChatWakeBus & {
  emit<K extends ChatWakeEventName>(event: K, payload: ChatWakeEvents[K]): void;
} {
  const handlers = new Map<string, Set<(payload: never) => void>>();
  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (payload: never) => void);
      return () => set.delete(handler as (payload: never) => void);
    },
    emit(event, payload) {
      if (event === "reply:new") {
        for (const listener of replyNewListeners) {
          listener(payload as ReplyNewWake);
        }
      }
      for (const h of handlers.get(event) ?? []) {
        (h as (p: unknown) => void)(payload);
      }
    },
  };
}
