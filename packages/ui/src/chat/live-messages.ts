/**
 * Normalize hq-pro conversation payloads into ConversationMessageWire[].
 * REST pages are newest-first; callers reverse for oldest → newest display.
 */

import { isAppNoticeBody } from "./agent-channel.js";
import type { ConversationMessageWire } from "./chat-api.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value).trim();
  return text || undefined;
}

function optionalReplyCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * A row is a reply iff `rootEventId` is non-empty AND not the row's own
 * `eventId`. Missing / blank `rootEventId` stays a root (old list rows).
 */
export function isReplyMessage(
  row: Pick<ConversationMessageWire, "eventId" | "rootEventId">,
): boolean {
  const rootEventId = (row.rootEventId ?? "").trim();
  return rootEventId.length > 0 && rootEventId !== row.eventId;
}

/**
 * Fold the reply rows a fetched page already carries onto their root rows:
 * `lastReplyAt` (newest reply time) and `replyAuthors` (distinct, in
 * first-appearance order). hq-pro stores only `replyCount` on the root and
 * returns replies as ordinary rows in the SAME channel/DM partition page, so
 * this derives the Slack-style affordance data with NO extra fetch.
 *
 * Pure and order-independent: replies may be mapped before or after their
 * root. Roots with no replies in the page are returned untouched (count-only
 * rendering), never half-populated.
 */
export function foldReplyMetadata(
  rows: readonly ConversationMessageWire[],
): ConversationMessageWire[] {
  const repliesByRoot = new Map<string, ConversationMessageWire[]>();
  for (const row of rows) {
    if (!isReplyMessage(row)) continue;
    const rootId = (row.rootEventId ?? "").trim();
    if (!rootId) continue;
    const list = repliesByRoot.get(rootId);
    if (list) list.push(row);
    else repliesByRoot.set(rootId, [row]);
  }
  if (repliesByRoot.size === 0) return rows.slice();

  return rows.map((row) => {
    const replies = repliesByRoot.get(row.eventId);
    if (!replies || isReplyMessage(row)) return row;
    const ordered = [...replies].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.eventId < b.eventId
          ? -1
          : 1
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    );
    let replyAuthors = [...(row.replyAuthors ?? [])];
    for (const reply of ordered) {
      replyAuthors = appendReplyAuthor(replyAuthors, reply);
    }
    const newest = ordered[ordered.length - 1]?.createdAt ?? null;
    return {
      ...row,
      // A page only ever adds replies, so never move lastReplyAt backwards.
      lastReplyAt: laterIso(newest, row.lastReplyAt ?? null),
      ...(replyAuthors.length > 0 ? { replyAuthors } : {}),
    };
  });
}

/** Later of two ISO stamps; tolerant of blank/unparseable values. */
export function laterIso(
  candidate: string | null | undefined,
  current: string | null | undefined,
): string | null {
  const next = (candidate ?? "").trim();
  const prev = (current ?? "").trim();
  if (!next) return prev || null;
  if (!prev) return next;
  const nextTs = Date.parse(next);
  const prevTs = Date.parse(prev);
  if (!Number.isFinite(nextTs)) return prev;
  if (!Number.isFinite(prevTs) || nextTs >= prevTs) return next;
  return prev;
}

/** Append a reply's author to a distinct, first-appearance-ordered list.
 *  Keyed by personUid, falling back to the display name for uid-less rows. */
export function appendReplyAuthor(
  authors: NonNullable<ConversationMessageWire["replyAuthors"]>,
  reply: Pick<
    ConversationMessageWire,
    "fromPersonUid" | "fromDisplayName" | "fromEmail"
  >,
): NonNullable<ConversationMessageWire["replyAuthors"]> {
  const personUid = (reply.fromPersonUid ?? "").trim();
  const displayName =
    (reply.fromDisplayName ?? "").trim() || (reply.fromEmail ?? "").trim();
  const key = personUid || displayName;
  if (!key) return authors;
  if (authors.some((a) => (a.personUid || a.displayName) === key)) {
    return authors;
  }
  return [
    ...authors,
    {
      personUid,
      displayName: displayName || personUid,
      ...(personUid.startsWith("agt_") ? { agent: true } : {}),
    },
  ];
}

/** Newest-first page size used when hydrating the main timeline. */
export const TIMELINE_ROOT_PAGE_SIZE = 50;
/** Extra newest-first pages fetched when the first page is mostly replies. */
export const TIMELINE_ROOT_MAX_EXTRA_PAGES = 3;

/** The `view` value that asks a history route for the human view. */
export const HUMAN_HISTORY_VIEW = "human" as const;

export interface TimelineMessagePage {
  messages?: unknown;
  nextCursor?: string | null;
  /**
   * `"human"` only when the server echoed `view: "human"`, which means it
   * filtered and paged this response itself. A server that predates the
   * parameter ignores it and echoes nothing, so an absent value marks an
   * ordinary unfiltered page.
   */
  view?: typeof HUMAN_HISTORY_VIEW;
  /**
   * The server's read budget ran out before it filled the page. It always
   * comes with a `nextCursor`; `messages` may be short or empty and the
   * caller should request the next page. Read only on a `view: "human"` page.
   */
  viewScanTruncated?: boolean;
}

/**
 * Pull `{ messages, nextCursor }` out of an hq-pro / adapter payload, plus
 * the `view` echo and `viewScanTruncated` of a server-filtered page.
 */
export function timelinePageFromPayload(raw: unknown): TimelineMessagePage {
  const rec = asRecord(raw);
  if (!rec) return { messages: raw, nextCursor: null };
  const cursor =
    typeof rec.nextCursor === "string" && rec.nextCursor.trim()
      ? rec.nextCursor.trim()
      : null;
  const humanView = rec.view === HUMAN_HISTORY_VIEW;
  return {
    messages: rec.messages ?? raw,
    nextCursor: cursor,
    ...(humanView ? { view: HUMAN_HISTORY_VIEW } : {}),
    ...(humanView && rec.viewScanTruncated === true
      ? { viewScanTruncated: true }
      : {}),
  };
}

/**
 * Collect newest-first roots for the main timeline. Filter runs AFTER
 * mapping so missing `rootEventId` stays a root. Over-fetches until
 * `pageSize` roots are collected or the cursor is exhausted (cap
 * `maxExtraPages` extra pages).
 */
export async function collectTimelineRoots(options: {
  fetchPage: (cursor: string | null) => Promise<TimelineMessagePage>;
  pageSize?: number;
  maxExtraPages?: number;
  initialCursor?: string | null;
}): Promise<{
  roots: ConversationMessageWire[];
  nextCursor: string | null;
}> {
  const pageSize = options.pageSize ?? TIMELINE_ROOT_PAGE_SIZE;
  const maxExtraPages = options.maxExtraPages ?? TIMELINE_ROOT_MAX_EXTRA_PAGES;
  const roots: ConversationMessageWire[] = [];
  // Reply rows seen across every fetched page. A reply is always NEWER than
  // its root, so any root in this newest-first window has all of its replies
  // in the same window — collected here and folded onto the roots below.
  const replyRows: ConversationMessageWire[] = [];
  const seen = new Set<string>();
  let cursor: string | null = options.initialCursor ?? null;
  const maxPages = 1 + Math.max(0, maxExtraPages);

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    if (pageIndex > 0 && (!cursor || roots.length >= pageSize)) break;
    const page = await options.fetchPage(
      pageIndex === 0 ? (options.initialCursor ?? null) : cursor,
    );
    const mapped = normalizeConversationMessages(
      page.messages !== undefined ? page.messages : page,
    );
    for (const row of mapped) {
      if (isReplyMessage(row)) {
        replyRows.push(row);
        continue;
      }
      if (seen.has(row.eventId)) continue;
      seen.add(row.eventId);
      roots.push(row);
    }
    cursor =
      typeof page.nextCursor === "string" && page.nextCursor.trim()
        ? page.nextCursor.trim()
        : null;
  }

  return {
    roots: foldReplyMetadata([...roots, ...replyRows]).filter(
      (row) => !isReplyMessage(row),
    ),
    nextCursor: cursor,
  };
}

function parseWireReactions(
  raw: unknown,
): ConversationMessageWire["reactions"] {
  const list = Array.isArray(raw) ? raw : [];
  const out: NonNullable<ConversationMessageWire["reactions"]> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const emoji = typeof rec.emoji === "string" ? rec.emoji.trim() : "";
    if (!emoji) continue;
    out.push({
      emoji,
      count: typeof rec.count === "number" ? rec.count : 0,
      reactedByMe: Boolean(rec.reactedByMe ?? rec.reacted_by_me),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseWireMentions(raw: unknown): ConversationMessageWire["mentions"] {
  const list = Array.isArray(raw) ? raw : [];
  const out: NonNullable<ConversationMessageWire["mentions"]> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const participantUid =
      typeof rec.participantUid === "string"
        ? rec.participantUid.trim()
        : typeof rec.participant_uid === "string"
          ? rec.participant_uid.trim()
          : "";
    const displayName =
      typeof rec.displayName === "string"
        ? rec.displayName.trim()
        : typeof rec.display_name === "string"
          ? rec.display_name.trim()
          : "";
    if (!participantUid || !displayName) continue;
    const participantType =
      typeof rec.participantType === "string"
        ? rec.participantType
        : typeof rec.participant_type === "string"
          ? rec.participant_type
          : undefined;
    out.push({
      participantUid,
      displayName,
      ...(participantType ? { participantType } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseWireAttachments(
  raw: unknown,
): ConversationMessageWire["attachments"] {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const out: NonNullable<ConversationMessageWire["attachments"]> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const vaultPath =
      typeof rec.vaultPath === "string"
        ? rec.vaultPath.trim()
        : typeof rec.vault_path === "string"
          ? rec.vault_path.trim()
          : "";
    const name =
      typeof rec.name === "string"
        ? rec.name.trim()
        : vaultPath.split("/").pop() || "";
    if (!vaultPath && !name) continue;
    out.push({
      id: typeof rec.id === "string" ? rec.id : null,
      vaultPath,
      companyUid:
        typeof rec.companyUid === "string"
          ? rec.companyUid
          : typeof rec.company_uid === "string"
            ? rec.company_uid
            : null,
      name: name || vaultPath,
      contentType:
        typeof rec.contentType === "string"
          ? rec.contentType
          : typeof rec.content_type === "string"
            ? rec.content_type
            : null,
      sizeBytes:
        typeof rec.sizeBytes === "number"
          ? rec.sizeBytes
          : typeof rec.size_bytes === "number"
            ? rec.size_bytes
            : null,
      kind: typeof rec.kind === "string" ? rec.kind : null,
      previewUrl: typeof rec.previewUrl === "string" ? rec.previewUrl : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** What {@link normalizeConversationMessages} keeps beyond the fields every conversation reads. */
export interface NormalizeMessagesOptions {
  /**
   * Keep each row's `audience`. Off by default, as it always was: rows of a
   * channel or a conversation between people carry no audience, so nothing
   * about how those are shown (the human-only view reads the field) changes.
   * A one-to-one conversation with a bot turns it on, to leave out the rows
   * written for the bot only ({@link botDmRows}).
   */
  keepAudience?: boolean;
}

export function normalizeConversationMessages(
  raw: unknown,
  options: NormalizeMessagesOptions = {},
): ConversationMessageWire[] {
  const rec = asRecord(raw);
  const list = Array.isArray(rec?.messages)
    ? rec.messages
    : Array.isArray(raw)
      ? raw
      : [];
  const out: ConversationMessageWire[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    const eventId = asString(row.eventId || row.id).trim();
    if (!eventId) continue;
    const rootEventId = optionalString(row.rootEventId);
    const replyCount = optionalReplyCount(row.replyCount);
    const lastReplyAt = optionalString(row.lastReplyAt);
    const audience = options.keepAudience ? optionalString(row.audience) : undefined;
    out.push({
      eventId,
      fromPersonUid: asString(row.fromPersonUid) || null,
      fromEmail: asString(row.fromEmail) || null,
      fromDisplayName: asString(row.fromDisplayName) || null,
      body: asString(row.body) || null,
      details: asString(row.details) || null,
      prompt: asString(row.prompt) || null,
      createdAt: asString(row.createdAt) || new Date(0).toISOString(),
      direction: asString(row.direction) || undefined,
      messageKind: asString(row.messageKind) || null,
      systemEvent: row.systemEvent,
      // Structured blocks (cards, tables): kept as sent, validated where drawn
      // (richMessageContent.ts). The body stays the plain-text fallback.
      ...(row.richContent != null ? { richContent: row.richContent } : {}),
      reactions: parseWireReactions(row.reactions),
      mentions: parseWireMentions(row.mentions),
      attachments: parseWireAttachments(row.attachments ?? row.attachment),
      ...(row.forwardedFrom !== undefined ? { forwardedFrom: row.forwardedFrom } : {}),
      ...(asString(row.forwardNote) ? { forwardNote: asString(row.forwardNote) } : {}),
      ...(row.omittedAttachments !== undefined
        ? { omittedAttachments: row.omittedAttachments }
        : {}),
      ...(rootEventId ? { rootEventId } : {}),
      ...(replyCount !== undefined ? { replyCount } : {}),
      ...(lastReplyAt ? { lastReplyAt } : {}),
      ...(audience ? { audience } : {}),
    });
  }
  return out;
}

/** How a conversation's fetched rows are laid out on the main timeline. */
export interface TimelineDisplayOptions {
  /**
   * A one-to-one conversation with a bot. Replies stay in their thread, as in
   * any other conversation, with three differences: the app's own requests to
   * the bot ({@link isAppRequestRow}) are left out, a reply whose root is not
   * on the timeline is shown on it, and {@link keepReplyInMain} can keep other
   * replies there too.
   */
  botDm?: boolean;
  /** In a bot conversation, a reply that stays on the main timeline. */
  keepReplyInMain?: (reply: ConversationMessageWire, root: ConversationMessageWire) => boolean;
  /**
   * The signed-in person's uid, for {@link isAppRequestRow}: with it, a row
   * that carries no audience counts as the app's own request only when this
   * person sent it.
   */
  selfUid?: string | null;
}

/** A uid of a bot, hosted or local. */
function isAgentUid(uid: string): boolean {
  return uid.startsWith("agt_");
}

/**
 * Whether a row is one of the app's own requests to the bot, which the
 * person never sees: the hello request after setup, a notice that an app was
 * connected. The app sends them for the person on the bot-only lane.
 *
 * - A row the bot sent is never one, whatever it says and whatever it is
 *   tagged. A bot that starts an answer with the app's opening words (it is
 *   quoting them, or was led to) is answering the person: hiding that answer
 *   leaves the person looking at "stopped responding".
 * - A row tagged `audience: "agent"` is one. That is the lane the app sends
 *   on. The server stores the tag, but its direct-message thread read does
 *   not return it yet, so most rows arrive with no tag (next rule).
 * - A row with any other audience is not one. It came from the server, and
 *   the server says it is for the person: a message the person typed
 *   themselves, even one that starts with the app's opening words.
 * - A row with no audience at all is one only when it is one of the app's
 *   notices (the hello request, a connection notice, or a first-run setup
 *   note: its lead and its handoff JSON, `isAppNoticeBody`) AND the
 *   person sent it AND it is not a message on its way
 *   out (`local-send-`). That is a copy of the request from the host's stored
 *   thread, which does not keep the lane. With `selfUid` the sender must be
 *   that person; without it, any sender that is not a bot, which in a
 *   one-to-one conversation with a bot is the person.
 */
export function isAppRequestRow(
  row: Pick<ConversationMessageWire, "eventId" | "fromPersonUid" | "audience" | "body">,
  options: { selfUid?: string | null } = {},
): boolean {
  const from = (row.fromPersonUid ?? "").trim();
  if (isAgentUid(from)) return false;
  const audience = (row.audience ?? "").trim().toLowerCase();
  if (audience === "agent") return true;
  if (audience !== "") return false;
  if (!isAppNoticeBody(row.body)) return false;
  if ((row.eventId ?? "").startsWith("local-send-")) return false;
  const self = (options.selfUid ?? "").trim();
  return self ? from === self : from !== "";
}

/**
 * Lay out rows of a conversation with a bot, oldest first. The app's own
 * requests to the bot are left out. A reply stays a reply when its root is
 * on the timeline (in `rows` or `knownRoots`); otherwise, or when
 * `keepReplyInMain` says so, it loses its root and shows on the main
 * timeline. A hidden request's answer, such as the bot's first message, is
 * therefore shown. Same array when nothing changes.
 */
export function botDmRows(
  rows: readonly ConversationMessageWire[],
  options: Pick<TimelineDisplayOptions, "selfUid" | "keepReplyInMain"> = {},
  knownRoots: readonly ConversationMessageWire[] = [],
): ConversationMessageWire[] {
  const shown = rows.filter((row) => !isAppRequestRow(row, options));
  let changed = shown.length !== rows.length;
  const roots = new Map<string, ConversationMessageWire>();
  for (const row of [...knownRoots, ...shown]) {
    if (!isReplyMessage(row)) roots.set(row.eventId, row);
  }
  const out = shown.map((row) => {
    if (!isReplyMessage(row)) return row;
    const root = roots.get((row.rootEventId ?? "").trim());
    if (root && !options.keepReplyInMain?.(row, root)) return row;
    changed = true;
    const { rootEventId: _root, ...main } = row;
    return main;
  });
  return changed ? out : (rows as ConversationMessageWire[]);
}

export function missingBotDmRootIds(
  raw: unknown,
  knownRoots: readonly ConversationMessageWire[] = [],
): string[] {
  const pageRows = normalizeConversationMessages(raw, { keepAudience: true });
  const roots = new Set<string>();
  for (const row of [...knownRoots, ...pageRows]) {
    if (!isReplyMessage(row)) roots.add(row.eventId);
  }
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const row of pageRows) {
    if (!isReplyMessage(row)) continue;
    const rootEventId = (row.rootEventId ?? "").trim();
    if (!rootEventId || roots.has(rootEventId) || seen.has(rootEventId)) continue;
    seen.add(rootEventId);
    missing.push(rootEventId);
  }
  return missing;
}

export function withFetchedTimelineRoots(
  raw: unknown,
  fetchedRoots: readonly unknown[],
): unknown {
  if (fetchedRoots.length === 0) return raw;
  if (Array.isArray(raw)) return [...raw, ...fetchedRoots];
  const record = asRecord(raw);
  if (!record) return { messages: [...fetchedRoots] };
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return { ...record, messages: [...messages, ...fetchedRoots] };
}

/**
 * The timeline plus one row per thread `agentUid` answered in, at the
 * thread's last reply. A bot's answer in its thread is folded off the
 * timeline, and code that asks "did the bot answer last?" needs to see it.
 * Same array when no thread has an answer from the bot.
 */
export function withThreadAnswers(
  rows: ConversationMessageWire[],
  agentUid: string,
): ConversationMessageWire[] {
  const uid = agentUid.trim();
  if (!uid) return rows;
  const answers: ConversationMessageWire[] = [];
  for (const row of rows) {
    if (!row.lastReplyAt) continue;
    if (!(row.replyAuthors ?? []).some((author) => author.personUid === uid)) continue;
    answers.push({ eventId: `${row.eventId}#thread`, fromPersonUid: uid, createdAt: row.lastReplyAt });
  }
  return answers.length > 0 ? [...rows, ...answers] : rows;
}

/**
 * Count replies from a page that does not carry their root (a `since`
 * catch-up) onto the root already on the timeline. A reply counts once: only
 * when it is newer than the root's last known reply, so the same page read
 * again changes nothing.
 */
function countRepliesOntoRoots(
  rows: ConversationMessageWire[],
  replies: readonly ConversationMessageWire[],
): ConversationMessageWire[] {
  if (replies.length === 0) return rows;
  const index = new Map(rows.map((row, i) => [row.eventId, i]));
  let out = rows;
  const ordered = [...replies].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const reply of ordered) {
    const at = index.get((reply.rootEventId ?? "").trim());
    if (at === undefined) continue;
    const root = out[at]!;
    const last = root.lastReplyAt ? Date.parse(root.lastReplyAt) : Number.NaN;
    const replyAt = Date.parse(reply.createdAt);
    const isNew = !Number.isFinite(last) || (Number.isFinite(replyAt) && replyAt > last);
    const replyAuthors = appendReplyAuthor([...(root.replyAuthors ?? [])], reply);
    if (!isNew && replyAuthors.length === (root.replyAuthors ?? []).length) continue;
    if (out === rows) out = rows.slice();
    out[at] = {
      ...root,
      ...(isNew ? { replyCount: (root.replyCount ?? 0) + 1 } : {}),
      lastReplyAt: laterIso(reply.createdAt, root.lastReplyAt ?? null) ?? undefined,
      replyAuthors,
    };
  }
  return out;
}

/** REST returns newest-first; ChannelConversation wants oldest → newest. */
export function messagesForDisplay(
  raw: unknown,
  options: TimelineDisplayOptions = {},
): ConversationMessageWire[] {
  // Every conversation reader needs the server's audience now. An absent tag
  // remains absent, so older and untagged rows retain their human-visible
  // behavior while an explicit agent lane can be filtered correctly.
  const oldestFirst = [...normalizeConversationMessages(raw, { keepAudience: true })].reverse();
  const rows = options.botDm ? botDmRows(oldestFirst, options) : oldestFirst;
  // Fold FIRST: the reply rows carry the author + time the root affordance
  // needs, and are discarded on the next line.
  return foldReplyMetadata(rows)
    .filter((row) => !isReplyMessage(row));
}

function mergeAttachmentFields(
  prev: ConversationMessageWire["attachments"],
  incoming: ConversationMessageWire["attachments"],
): ConversationMessageWire["attachments"] {
  if (!incoming || incoming.length === 0) return prev ?? incoming;
  if (!prev || prev.length === 0) return incoming;
  return incoming.map((item, index) => {
    const match =
      prev.find(
        (row) =>
          (item.id && row.id === item.id) ||
          (item.vaultPath && row.vaultPath === item.vaultPath),
      ) ?? prev[index];
    if (!match) return item;
    return {
      ...match,
      ...item,
      kind: item.kind || match.kind,
      contentType: item.contentType || match.contentType,
      previewUrl: item.previewUrl || match.previewUrl,
      companyUid: item.companyUid || match.companyUid,
    };
  });
}

/** Merge a targeted CHAN_MSG page into the open timeline. Dedupes by eventId
 * (incoming wins, keeps local previewUrl when the server omits it) and sorts
 * oldest → newest. Existing row objects stay in place when unchanged. */
export function mergeTimelineMessages(
  existing: ConversationMessageWire[],
  incoming: ConversationMessageWire[],
): ConversationMessageWire[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, ConversationMessageWire>();
  for (const row of existing) byId.set(row.eventId, row);
  let changed = false;
  for (const row of incoming) {
    const prev = byId.get(row.eventId);
    if (prev === row) continue;
    if (!prev) {
      byId.set(row.eventId, row);
      changed = true;
      continue;
    }
    // Reply metadata is derived per page, so a catch-up page that carries the
    // root but not its replies must not wipe what an earlier page folded.
    let replyAuthors = [...(prev.replyAuthors ?? [])];
    for (const author of row.replyAuthors ?? []) {
      replyAuthors = appendReplyAuthor(replyAuthors, {
        fromPersonUid: author.personUid,
        fromDisplayName: author.displayName,
      });
    }
    byId.set(row.eventId, {
      ...prev,
      ...row,
      attachments: mergeAttachmentFields(prev.attachments, row.attachments),
      mentions: row.mentions ?? prev.mentions,
      reactions: row.reactions ?? prev.reactions,
      lastReplyAt: laterIso(row.lastReplyAt, prev.lastReplyAt),
      ...(replyAuthors.length > 0 ? { replyAuthors } : {}),
    });
    changed = true;
  }
  if (!changed) return existing;
  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.eventId < b.eventId ? -1 : 1;
  });
}

export function timelineHasEvent(
  messages: ConversationMessageWire[],
  eventId: string | undefined,
): boolean {
  if (!eventId) return false;
  return messages.some((row) => row.eventId === eventId);
}

/**
 * Merge a REST conversation page into the open timeline. Roots from the
 * page replace/extend existing rows; event ids that are replies in the
 * page are dropped so a leaked cache row cannot stay on the main timeline.
 */
export function mergeFetchedTimeline(
  existing: ConversationMessageWire[],
  raw: unknown,
  options: TimelineDisplayOptions = {},
): ConversationMessageWire[] {
  if (options.botDm) {
    // Rows already on the timeline (a cached thread, rows the host seeded)
    // get the same treatment as the page, so a request for the bot cannot
    // linger and an answer whose root is gone is not lost.
    const shown = botDmRows(existing, options);
    const page = botDmRows(
      [...normalizeConversationMessages(raw, { keepAudience: true })].reverse(),
      options,
      shown,
    );
    const replies = page.filter(isReplyMessage);
    const replyIds = new Set(replies.map((row) => row.eventId));
    const kept = shown.filter((row) => !replyIds.has(row.eventId) && !isReplyMessage(row));
    const roots = foldReplyMetadata(page).filter((row) => !isReplyMessage(row));
    const merged = countRepliesOntoRoots(mergeTimelineMessages(kept, roots), replies);
    if (merged === existing) return existing;
    return timelinesContentEqual(existing, merged) ? existing : merged;
  }
  const page = timelinePageFromPayload(raw);
  const mapped = normalizeConversationMessages(
    page.messages !== undefined ? page.messages : raw,
  );
  const replyIds = new Set(
    mapped.filter(isReplyMessage).map((row) => row.eventId),
  );
  const kept = existing.filter(
    (row) => !replyIds.has(row.eventId) && !isReplyMessage(row),
  );
  const merged = mergeTimelineMessages(kept, messagesForDisplay(raw));
  // The safety catch-up refetches the open page every few seconds; when the
  // page carries nothing new, hand back the caller's own array so `$state`
  // consumers (and every derived hanging off the timeline) stay untouched.
  if (merged === existing) return existing;
  return timelinesContentEqual(existing, merged) ? existing : merged;
}

function shallowValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `null` and a missing/undefined field are the same absent wire value.
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function timelineRowsEqual(
  a: ConversationMessageWire,
  b: ConversationMessageWire,
): boolean {
  if (a === b) return true;
  if (a.eventId !== b.eventId) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<
    keyof ConversationMessageWire
  >;
  for (const key of keys) {
    // A missing key and an explicit `undefined` are the same wire value.
    if (!shallowValueEqual(a[key], b[key])) return false;
  }
  return true;
}

/** True when both timelines hold the same rows in the same order — same
 * length, same eventIds, and every row field content-equal (so edits,
 * reactions, attachments and reply metadata still count as changes). */
export function timelinesContentEqual(
  a: ConversationMessageWire[],
  b: ConversationMessageWire[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!timelineRowsEqual(a[i], b[i])) return false;
  }
  return true;
}

/** Exclusive `since` for GET /messages: last durable local timestamp, else
 * just before the wake's createdAt so that one event is included. */
/** Promote a send POST `{ eventId, createdAt }` into a durable timeline row. */
export function sentMessageFromResult(
  raw: unknown,
  extras: {
    body: string;
    direction?: ConversationMessageWire["direction"];
    fromPersonUid?: string | null;
    fromDisplayName?: string | null;
    mentions?: ConversationMessageWire["mentions"];
    attachments?: ConversationMessageWire["attachments"];
  },
): ConversationMessageWire | null {
  const rec = asRecord(raw);
  const eventId = asString(rec?.eventId).trim();
  if (!eventId) return null;
  return {
    eventId,
    fromPersonUid: extras.fromPersonUid ?? null,
    fromEmail: null,
    fromDisplayName: extras.fromDisplayName ?? "You",
    body: extras.body,
    details: null,
    prompt: null,
    createdAt: asString(rec?.createdAt) || new Date().toISOString(),
    direction: extras.direction ?? "out",
    messageKind: null,
    mentions: extras.mentions,
    attachments: extras.attachments,
  };
}

export function sinceForChannelWake(
  local: ConversationMessageWire[],
  wakeCreatedAt?: string,
): string | undefined {
  let newest: string | undefined;
  for (const row of local) {
    if (row.eventId.startsWith("local-send-")) continue;
    if (row.createdAt && (!newest || row.createdAt > newest)) {
      newest = row.createdAt;
    }
  }
  // Exclusive `since` on the exact newest timestamp drops same-ms siblings
  // (member_added is written with the mention's createdAt).
  if (newest) {
    const ms = Date.parse(newest);
    if (!Number.isNaN(ms)) return new Date(ms - 1).toISOString();
    return newest;
  }
  if (!wakeCreatedAt) return undefined;
  const ms = Date.parse(wakeCreatedAt);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms - 1).toISOString();
}
