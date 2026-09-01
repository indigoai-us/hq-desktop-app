/**
 * Platform-agnostic glue that folds a work-mesh snapshot overlay onto the
 * display shell (sidebar directory + per-row board/messages/files/status).
 *
 * The overlay itself is produced by @hq/core (`overlayFromSnapshot`). WHERE the
 * snapshot comes from is platform-specific:
 *   - desktop reads ~/.hq/work-mesh/cache via Rust (`invoke`),
 *   - web reads the same files with Node `fs` in a server load.
 * Both then reuse the accessors below, so this module lives in @hq/ui and stays
 * free of any Tauri / Node / fetch dependency (ui-purity gate).
 */

import {
  isLiveMeshChannelId,
  overlayFromSnapshot,
  parseWorkMeshSnapshot,
  type MeshCachedMessage,
  type MeshDirectoryRow,
  type MeshShellOverlay,
  type WorkMeshSnapshot,
} from "@hq/core";
import {
  buildChannelStatusModel,
  extractStoryId,
  type ChannelStatusModel,
  type LiveAgentStatusRow,
  type StatusMemberInput,
} from "../chat/channel-status-model.js";
import type { WorkMeshThread } from "../board/thread-model.js";
import type {
  ChatSidebarApi,
  ConversationMessageWire,
  NotificationsApi,
} from "../chat/chat-api.js";
import type { ChannelDirectoryFeed } from "../chat/channel-directory-reconciler.js";
import {
  mergeContactsWithInbox,
  stampContactsFromDmThreads,
  takeDirectorySeed,
  type ConversationRow,
  type DmContactInput,
  type InboxEventInput,
  type PairUnreadInput,
} from "../chat/sidebar-model.js";
import type {
  BoardTabData,
  ChannelFileItemModel,
} from "../chat/messaging/channelTabModels.js";
import type { Workspace } from "../chat/workspaces.js";
import { humanizeChannelName } from "../chat/channels.js";

export const EMPTY_OVERLAY: MeshShellOverlay = {
  rows: [],
  messagesByChannelId: {},
  boardByChannelId: {},
  filesByChannelId: {},
  statusByChannelId: {},
};

export function overlayFromRawSnapshot(raw: unknown): MeshShellOverlay {
  return overlayFromSnapshot(parseWorkMeshSnapshot(raw as WorkMeshSnapshot));
}

export interface MeshDmBundle {
  contacts: DmContactInput[];
  messagesByPersonUid: Record<string, ConversationMessageWire[]>;
}

export const EMPTY_DM_BUNDLE: MeshDmBundle = {
  contacts: [],
  messagesByPersonUid: {},
};

/**
 * 1:1 DMs live in cache/contacts + cache/inbox + cache/dms — not the
 * channel directory. Desktop's Rust snapshot (and tests) pass those blobs
 * through here so the sidebar can paint pair threads without a live fetch.
 */
export function dmBundleFromRawSnapshot(raw: unknown): MeshDmBundle {
  if (!raw || typeof raw !== "object") return EMPTY_DM_BUNDLE;
  const rec = raw as Record<string, unknown>;
  const contacts = flattenContacts(rec.contacts);
  const { events, pairUnreads } = flattenInbox(rec.inbox);
  const threads = flattenDmThreads(rec.dms);
  const messagesByPersonUid: Record<string, ConversationMessageWire[]> = {};
  const stamps: Array<{
    personUid: string;
    lastMessageAt?: string | null;
    displayName?: string | null;
    unreadCount?: number | null;
  }> = [];
  for (const thread of threads) {
    if (thread.messages.length > 0) {
      messagesByPersonUid[thread.personUid] = thread.messages;
    }
    const last = newestMessage(thread.messages);
    stamps.push({
      personUid: thread.personUid,
      lastMessageAt: last?.createdAt ?? null,
      displayName: last?.fromDisplayName ?? null,
      unreadCount: thread.unreadCount,
    });
  }
  return {
    contacts: stampContactsFromDmThreads(
      mergeContactsWithInbox(contacts, events, pairUnreads),
      stamps,
    ),
    messagesByPersonUid,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenContacts(raw: unknown): DmContactInput[] {
  const lists = Array.isArray(raw) ? raw : [];
  const out: DmContactInput[] = [];
  const seen = new Set<string>();
  for (const item of lists) {
    const rows =
      isRecord(item) && Array.isArray(item.contacts) ? item.contacts : [item];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const personUid = String(row.personUid ?? "").trim();
      if (!personUid || seen.has(personUid)) continue;
      seen.add(personUid);
      out.push({
        personUid,
        email: typeof row.email === "string" ? row.email : null,
        displayName:
          typeof row.displayName === "string" ? row.displayName : null,
        lastMessageAt:
          typeof row.lastMessageAt === "string" ? row.lastMessageAt : null,
        lastActivityAt:
          typeof row.lastActivityAt === "string" ? row.lastActivityAt : null,
        unreadCount:
          typeof row.unreadCount === "number" ? row.unreadCount : null,
      });
    }
  }
  return out;
}

function flattenInbox(raw: unknown): {
  events: InboxEventInput[];
  pairUnreads: PairUnreadInput[];
} {
  const lists = Array.isArray(raw) ? raw : [];
  const events: InboxEventInput[] = [];
  const pairUnreads: PairUnreadInput[] = [];
  for (const item of lists) {
    if (!isRecord(item)) continue;
    const eventRows = Array.isArray(item.events)
      ? item.events
      : Array.isArray(item)
        ? item
        : [];
    for (const event of eventRows) {
      if (!isRecord(event)) continue;
      events.push({
        fromPersonUid:
          typeof event.fromPersonUid === "string"
            ? event.fromPersonUid
            : undefined,
        fromEmail:
          typeof event.fromEmail === "string" ? event.fromEmail : undefined,
        fromDisplayName:
          typeof event.fromDisplayName === "string"
            ? event.fromDisplayName
            : undefined,
        createdAt:
          typeof event.createdAt === "string" ? event.createdAt : undefined,
      });
    }
    for (const pair of Array.isArray(item.pairUnreads)
      ? item.pairUnreads
      : []) {
      if (!isRecord(pair)) continue;
      pairUnreads.push({
        withPersonUid:
          typeof pair.withPersonUid === "string"
            ? pair.withPersonUid
            : undefined,
        unreadCount:
          typeof pair.unreadCount === "number" ? pair.unreadCount : undefined,
      });
    }
  }
  return { events, pairUnreads };
}

function newestMessage<T extends { createdAt?: string | null }>(
  messages: readonly T[],
): T | undefined {
  let best: T | undefined;
  let bestAt = "";
  for (const message of messages) {
    const at = (message.createdAt ?? "").trim();
    if (!at) continue;
    if (!best || at > bestAt) {
      best = message;
      bestAt = at;
    }
  }
  return best;
}

function flattenDmThreads(raw: unknown): Array<{
  personUid: string;
  unreadCount: number | null;
  messages: ConversationMessageWire[];
}> {
  const lists = Array.isArray(raw) ? raw : [];
  const out: Array<{
    personUid: string;
    unreadCount: number | null;
    messages: ConversationMessageWire[];
  }> = [];
  for (const item of lists) {
    if (!isRecord(item)) continue;
    const personUid = String(item.personUid ?? "").trim();
    if (!personUid) continue;
    const rows = Array.isArray(item.messages) ? item.messages : [];
    const messages: ConversationMessageWire[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const eventId = String(row.eventId ?? "").trim();
      const createdAt = String(row.createdAt ?? "").trim();
      if (!eventId || !createdAt) continue;
      messages.push({
        eventId,
        createdAt,
        fromPersonUid:
          typeof row.fromPersonUid === "string" ? row.fromPersonUid : null,
        fromEmail: typeof row.fromEmail === "string" ? row.fromEmail : null,
        fromDisplayName:
          typeof row.fromDisplayName === "string" ? row.fromDisplayName : null,
        body: typeof row.body === "string" ? row.body : null,
        details: typeof row.details === "string" ? row.details : null,
        prompt: typeof row.prompt === "string" ? row.prompt : null,
        direction:
          typeof row.direction === "string" ? row.direction : undefined,
      });
    }
    const newestFirst =
      messages.length >= 2 &&
      Date.parse(messages[0]!.createdAt) >
        Date.parse(messages[messages.length - 1]!.createdAt);
    out.push({
      personUid,
      unreadCount:
        typeof item.unreadCount === "number" ? item.unreadCount : null,
      messages: newestFirst ? messages.slice().reverse() : messages,
    });
  }
  return out;
}

export function meshRowsAsDirectory(
  rows: MeshDirectoryRow[],
): ChannelDirectoryFeed["rows"] {
  return rows.map((row) => ({
    channelId: row.channelId,
    type: row.type,
    scope: row.scope,
    companyUid: row.companyUid,
    projectId: row.projectId ?? null,
    name: row.name,
    subtitle: row.subtitle,
    lastActivityAt: row.lastActivityAt,
    unreadCount: row.unreadCount,
    memberCount: row.memberCount,
  }));
}

export function wrapSidebarApi(
  base: ChatSidebarApi,
  getOverlay: () => MeshShellOverlay,
): ChatSidebarApi {
  return {
    ...base,
    fetchChannelDirectory: async () => cacheDirectoryFeed(getOverlay()),
  };
}

/**
 * Live hq-pro directory first; fall back to the local overlay when the
 * hosted API is empty or unreachable so a local machine still paints cache.
 */
export function createHybridSidebarApi(
  live: ChatSidebarApi,
  getOverlay: () => MeshShellOverlay,
  getContacts?: () => readonly DmContactInput[],
  persist?: CacheSidebarPersist,
): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (cursor) => {
      try {
        const feed = await live.fetchChannelDirectory(cursor);
        const count = (feed.rows?.length ?? 0) + (feed.changed?.length ?? 0);
        if (count > 0 || Boolean(cursor)) return feed;
      } catch {
        /* use cache */
      }
      return cacheDirectoryFeed(getOverlay());
    },
    listContacts: async () => {
      try {
        const res = await live.listContacts();
        if ((res.contacts?.length ?? 0) > 0) return res;
      } catch {
        /* use cache */
      }
      return { contacts: [...(getContacts?.() ?? [])] };
    },
    listDmRequests: () => live.listDmRequests(),
    listChannels: (args) => live.listChannels(args),
    markDmThreadRead: async (personUid) => {
      await persist?.markDmThreadRead?.(personUid);
    },
    markChannelRead: async (channelId) => {
      await persist?.markChannelRead?.(channelId);
    },
    ...(persist?.createChannel
      ? { createChannel: persist.createChannel.bind(persist) }
      : {}),
    ...(persist?.addChannelMember
      ? { addChannelMember: persist.addChannelMember.bind(persist) }
      : {}),
    sendChannelMessage: (args) =>
      persist?.sendChannelMessage
        ? persist.sendChannelMessage.call(persist, args)
        : live.sendChannelMessage(args),
    sendDm: (args) => live.sendDm(args),
    ...(persist?.sendDmToEmail
      ? { sendDmToEmail: persist.sendDmToEmail.bind(persist) }
      : {}),
    searchMessages: (args) => live.searchMessages(args),
  };
}

export interface CacheSidebarPersist {
  markDmThreadRead?(personUid: string): Promise<void>;
  markChannelRead?(channelId: string): Promise<void>;
  createChannel?: ChatSidebarApi["createChannel"];
  addChannelMember?: ChatSidebarApi["addChannelMember"];
  sendChannelMessage?: ChatSidebarApi["sendChannelMessage"];
  sendDm?: ChatSidebarApi["sendDm"];
  sendDmToEmail?: ChatSidebarApi["sendDmToEmail"];
}

/** Directory from the mesh overlay. Contacts come from inbox merge when given. */
export function createCacheSidebarApi(
  getOverlay: () => MeshShellOverlay,
  getContacts?: () => readonly DmContactInput[],
  persist?: CacheSidebarPersist,
): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => cacheDirectoryFeed(getOverlay()),
    listContacts: async () => ({ contacts: [...(getContacts?.() ?? [])] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async (personUid) => {
      await persist?.markDmThreadRead?.(personUid);
    },
    markChannelRead: async (channelId) => {
      await persist?.markChannelRead?.(channelId);
    },
    sendChannelMessage: async (args) => {
      if (!persist?.sendChannelMessage) {
        throw new Error("Message sending is unavailable while offline");
      }
      await persist.sendChannelMessage(args);
    },
    sendDm: async (args) => {
      if (!persist?.sendDm) {
        throw new Error("Message sending is unavailable while offline");
      }
      await persist.sendDm(args);
    },
    searchMessages: async () => ({ results: [] }),
    // Channel create/membership/send are live capabilities the host may wire
    // in. Forwarding them matters: the sidebar hides every "New channel"
    // affordance when `createChannel` is absent, so a cache api that drops
    // them silently removes channel creation from the whole app.
    ...(persist?.createChannel
      ? { createChannel: persist.createChannel.bind(persist) }
      : {}),
    ...(persist?.addChannelMember
      ? { addChannelMember: persist.addChannelMember.bind(persist) }
      : {}),
    ...(persist?.sendDmToEmail
      ? { sendDmToEmail: persist.sendDmToEmail.bind(persist) }
      : {}),
  };
}

/** Empty inbox — no authored notifications, no network. */
export function createEmptyNotificationsApi(): NotificationsApi {
  return {
    fetchNotifications: async () => ({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
    }),
    ackNotification: async () => {},
    readAllNotifications: async () => {},
    runNotificationAction: async () => ({}),
  };
}

function cacheDirectoryFeed(overlay: MeshShellOverlay): ChannelDirectoryFeed {
  const now = Date.now();
  return {
    contractVersion: 2,
    snapshot: true,
    cursor: "livecache00000000000000000000000000",
    cursorExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    rows: takeDirectorySeed(meshRowsAsDirectory(overlay.rows) ?? []),
  };
}

/** Distinct company scopes present in the overlay, as sidebar workspaces. */
export function companiesFromOverlay(overlay: MeshShellOverlay): Workspace[] {
  const seen = new Set<string>();
  const out: Workspace[] = [];
  for (const row of overlay.rows) {
    const uid = row.companyUid?.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      slug: uid,
      displayName: "Company",
      kind: "company",
      state: "synced",
      cloudUid: uid,
      bucketName: null,
      hasLocalFolder: false,
      localPath: null,
      membershipStatus: "active",
      role: "owner",
      lastSyncedAt: null,
      brokenReason: null,
      invitedBy: null,
      invitedAt: null,
    });
  }
  return out;
}

function conversationFromDirectoryRow(row: MeshDirectoryRow): ConversationRow {
  const kind =
    row.type === "dm" ? (row.scope === "group" ? "group" : "dm") : "channel";
  return {
    id: `ch:${row.channelId}`,
    kind,
    title: humanizeChannelName(row.name) || row.name,
    companyUid: row.companyUid,
    unreadDot: (row.unreadCount ?? 0) > 0,
    lastActivityAt: Date.parse(row.lastActivityAt ?? "") || 0,
    pinned: false,
    memberCount: row.memberCount,
    channelId: row.channelId,
    channelScope: row.scope,
  };
}

export function initialRowFromOverlay(
  overlay: MeshShellOverlay,
): ConversationRow | null {
  const row = overlay.rows[0];
  if (!row) return null;
  return conversationFromDirectoryRow(row);
}

function rowChannelId(row: ConversationRow): string {
  return row.channelId ?? row.title;
}

function isLiveRow(row: ConversationRow, overlay: MeshShellOverlay): boolean {
  const id = rowChannelId(row);
  return (
    isLiveMeshChannelId(id) ||
    Boolean(overlay.boardByChannelId[id] || overlay.messagesByChannelId[id])
  );
}

export function messagesForRow(
  row: ConversationRow,
  overlay: MeshShellOverlay,
  fallback: (row: ConversationRow) => ConversationMessageWire[],
): ConversationMessageWire[] {
  const id = rowChannelId(row);
  if (isLiveRow(row, overlay)) {
    return (overlay.messagesByChannelId[id] ?? []) as ConversationMessageWire[];
  }
  return fallback(row);
}

export function boardForRow(
  row: ConversationRow,
  overlay: MeshShellOverlay,
  fallback: (row: ConversationRow) => BoardTabData | null,
): BoardTabData | null {
  const id = rowChannelId(row);
  if (isLiveRow(row, overlay)) {
    return overlay.boardByChannelId[id] ?? { columns: [], stories: {} };
  }
  return fallback(row);
}

export function filesForRow(
  row: ConversationRow,
  overlay: MeshShellOverlay,
  fallback: (row: ConversationRow) => ChannelFileItemModel[],
): ChannelFileItemModel[] {
  const id = rowChannelId(row);
  if (isLiveRow(row, overlay)) {
    return overlay.filesByChannelId[id] ?? [];
  }
  return fallback(row);
}

export interface StatusForRowOptions {
  /** Active work-mesh threads (GET /v1/work-mesh/threads). */
  workThreads?: readonly WorkMeshThread[] | null;
  /**
   * Channel roster from GET /v1/notify/channels/{id}/members.
   * This is the creating entity (owner) plus anyone later invited — not
   * PROJECT_VIEW.updatedBy and not chat posters.
   */
  channelMembers?: readonly StatusMemberInput[] | null;
  /** person/agent uid → display name (contacts, work-mesh identities). */
  identities?: Readonly<Record<string, string>> | null;
}

export function isAgentUid(uid: string): boolean {
  const value = uid.trim().toLowerCase();
  return value.startsWith("agt_") || value.startsWith("agent:");
}

/** True when a label is still a raw principal uid, not a display name. */
export function looksLikePrincipalUid(value: string): boolean {
  return /^(prs|agt)_[a-z0-9]+$/i.test(value.trim());
}

/** First real display name; never keep a raw prs_ or agt_ uid as the label. */
export function resolveEntityDisplayName(
  uid: string,
  ...sources: Array<string | null | undefined>
): string {
  const id = uid.trim();
  for (const source of sources) {
    const name = (source ?? "").trim();
    if (name && !looksLikePrincipalUid(name)) return name;
  }
  return id;
}

export function identitiesFromContacts(
  contacts: ReadonlyArray<{
    personUid?: string | null;
    displayName?: string | null;
  }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const contact of contacts) {
    const uid = (contact.personUid ?? "").trim();
    const name = (contact.displayName ?? "").trim();
    if (!uid || !name || looksLikePrincipalUid(name)) continue;
    out[uid] = name;
  }
  return out;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse GET /v1/notify/channels/{id}/members into roster rows. */
export function parseChannelMembers(raw: unknown): StatusMemberInput[] {
  const body = rec(raw);
  const list = Array.isArray(body?.members)
    ? body.members
    : Array.isArray(raw)
      ? raw
      : [];
  const out: StatusMemberInput[] = [];
  for (const item of list) {
    const row = rec(item);
    if (!row) continue;
    const personUid = String(row.personUid ?? "").trim();
    if (!personUid) continue;
    // Enriched rosters may nest profile fields under effectiveProfile (mirrors
    // the company-members shape) or carry them flat — read both.
    const prof = rec(row.effectiveProfile) ?? {};
    const pick = (k: string): string | undefined => {
      const flat = row[k];
      if (typeof flat === "string" && flat.trim()) return flat.trim();
      const nested = prof[k];
      return typeof nested === "string" && nested.trim()
        ? nested.trim()
        : undefined;
    };
    const rawName = pick("displayName") ?? "";
    const agent = isAgentUid(personUid);
    out.push({
      personUid,
      displayName:
        rawName && !looksLikePrincipalUid(rawName) ? rawName : undefined,
      email: pick("email"),
      avatarUrl: pick("avatarUrl"),
      description: pick("description"),
      role:
        typeof row.role === "string" ? row.role : agent ? "agent" : "member",
      isAgent: agent,
    });
  }
  return out;
}

export function nameChannelMembers(
  roster: readonly StatusMemberInput[],
  identities?: Readonly<Record<string, string>> | null,
): StatusMemberInput[] {
  return roster.map((member) => {
    const uid = member.personUid.trim();
    return {
      ...member,
      displayName: resolveEntityDisplayName(
        uid,
        member.displayName,
        identities?.[uid],
      ),
    };
  });
}

/** Overlay a fetched channel roster onto an existing status model. */
export function applyChannelRoster(
  model: ChannelStatusModel,
  roster: readonly StatusMemberInput[],
  identities?: Readonly<Record<string, string>> | null,
): ChannelStatusModel {
  const named = nameChannelMembers(roster, identities);
  const rebuilt = buildChannelStatusModel({
    project: { id: "", title: "" },
    members: named,
    companyLabel: model.companyLabel,
  });
  return {
    ...model,
    members: rebuilt.members,
    agents: rebuilt.agents,
    memberCount: named.length || model.memberCount,
  };
}

/** Unique posters from the cached channel window — the live roster we have. */
export function membersFromMeshMessages(
  messages: readonly MeshCachedMessage[] | null | undefined,
): StatusMemberInput[] {
  const seen = new Set<string>();
  const out: StatusMemberInput[] = [];
  for (const message of messages ?? []) {
    const uid = (message.fromPersonUid ?? "").trim();
    const name = (message.fromDisplayName ?? "").trim();
    const email = (message.fromEmail ?? "").trim();
    const key = uid || name || email;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      personUid: uid || key,
      displayName: name || email || uid || "Unknown",
      email: email || undefined,
      isAgent: uid ? isAgentUid(uid) : false,
      role: uid && isAgentUid(uid) ? "agent" : "member",
    });
  }
  return out;
}

function displayNameForUid(
  uid: string,
  members: readonly StatusMemberInput[],
  identities?: Readonly<Record<string, string>> | null,
): string {
  const hit = members.find((row) => row.personUid === uid);
  return resolveEntityDisplayName(uid, hit?.displayName, identities?.[uid]);
}

const LIVE_THREAD_STATUSES = new Set(["progress", "start", "blocked", "check"]);

export function liveAgentsFromWorkThreads(
  threads: readonly WorkMeshThread[] | null | undefined,
  projectId: string | null | undefined,
  members: readonly StatusMemberInput[],
  identities?: Readonly<Record<string, string>> | null,
): LiveAgentStatusRow[] {
  const slug = (projectId ?? "").trim().toLowerCase();
  if (!slug) return [];
  const out: LiveAgentStatusRow[] = [];
  for (const thread of threads ?? []) {
    if (!LIVE_THREAD_STATUSES.has(thread.status)) continue;
    const project = (thread.project ?? "").trim().toLowerCase();
    if (project && project !== slug) continue;
    const owner = (thread.actor ?? "").trim();
    if (!owner) continue;
    const storyId = thread.storyId ?? extractStoryId(thread.note, thread.title);
    const running = thread.status === "progress" || thread.status === "start";
    const displayName = displayNameForUid(owner, members, identities);
    const percentMatch = (thread.note ?? "").match(/\b(\d{1,3})\s*%/);
    const parsedPercent = percentMatch
      ? Number.parseInt(percentMatch[1] ?? "", 10)
      : Number.NaN;
    out.push({
      id: thread.threadId,
      label: running
        ? `Agent running${storyId ? ` · ${storyId}` : ""}`
        : thread.status === "blocked"
          ? `Blocked${storyId ? ` · ${storyId}` : ""}`
          : displayName,
      storyId,
      progressPercent:
        Number.isFinite(parsedPercent) && parsedPercent <= 100
          ? parsedPercent
          : Number.NaN,
      status: running
        ? "running"
        : thread.status === "blocked"
          ? "awaiting_input"
          : "idle",
      tool: null,
      displayName,
    });
  }
  return out;
}

export function statusForRow(
  row: ConversationRow,
  overlay: MeshShellOverlay,
  fallback: (row: ConversationRow) => ChannelStatusModel | null,
  options: StatusForRowOptions = {},
): ChannelStatusModel | null {
  const id = rowChannelId(row);
  const mesh = overlay.statusByChannelId[id];
  const fill = fallback(row);
  // Live rows used to return null here, which hid the members dialog on
  // every project channel that has a directory row but no PROJECT_VIEW yet.
  if (!mesh) {
    return fill;
  }
  const projectId = mesh.projectId ?? null;
  const members = nameChannelMembers(
    options.channelMembers ?? [],
    options.identities,
  );
  const fromThreads = liveAgentsFromWorkThreads(
    options.workThreads,
    projectId,
    members,
    options.identities,
  );

  const built = buildChannelStatusModel({
    project: {
      id: projectId || id,
      title: row.title,
      company: mesh.companyLabel ?? undefined,
      storiesTotal: mesh.storiesTotal,
      storiesComplete: mesh.storiesComplete,
      description: mesh.description ?? null,
    },
    prd: {
      name: row.title,
      repos: mesh.repos,
      branchName: mesh.repos[0]?.branch ?? null,
      repoPath: mesh.repos[0]?.path ?? null,
    },
    members,
    companyLabel: mesh.companyLabel,
  });
  if (fromThreads.length > 0) {
    built.liveAgents = fromThreads;
  }
  return built;
}

export function searchRowsFromOverlay(
  overlay: MeshShellOverlay,
): ConversationRow[] {
  return overlay.rows.map(conversationFromDirectoryRow);
}

const PINS_KEY = "hq.chat.pins";
const CONVERSATION_CACHE_KEY = "hq.chat.conversation-cache";
const DIRECTORY_CURSOR_KEY = "hq.chat.channel-directory-cursor";

/** Drop leftover fixture pins / cached test conversations. */
export function clearFixtureSidebarState(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PINS_KEY);
    window.localStorage.removeItem(CONVERSATION_CACHE_KEY);
    window.localStorage.removeItem(DIRECTORY_CURSOR_KEY);
  } catch {
    /* private mode */
  }
}

/** Replace pins with live cache ids only — drop leftover fixture pins. */
export function seedMeshPins(channelIds: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PINS_KEY,
      JSON.stringify(channelIds.map((id) => `ch:${id}`)),
    );
  } catch {
    /* private mode */
  }
}
