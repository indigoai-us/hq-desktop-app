/**
 * Live sidebar extras for hosted web: inbox-backed 1:1 DMs, and work-mesh
 * dates/boards for notify-channel projects. Work-mesh threads are not
 * sidebar channels — desktop only paints GET /v1/notify/channels memberships.
 */

import {
  mergeContactsWithInbox,
  type BoardTabData,
  type Channel,
  type ChannelDirectoryRow,
  type DmContactInput,
  type InboxEventInput,
  type PairUnreadInput,
} from "@hq/ui";

export interface WorkFeedItem {
  projectId: string;
  companyUid: string | null;
  lastActivityAt: string | null;
  createdAt?: string | null;
  threadStatus?: string | null;
  progressSummary?: string | null;
  ownerUid?: string | null;
  threadId?: string | null;
}

export function parseInboxPage(raw: unknown): {
  events: InboxEventInput[];
  pairUnreads: PairUnreadInput[];
  nextCursor: string | null;
} {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const events = Array.isArray(rec?.events)
    ? (rec.events as InboxEventInput[])
    : [];
  const pairUnreads = Array.isArray(rec?.pairUnreads)
    ? (rec.pairUnreads as PairUnreadInput[])
    : [];
  const nextCursor =
    typeof rec?.nextCursor === "string" && rec.nextCursor.trim()
      ? rec.nextCursor
      : null;
  return { events, pairUnreads, nextCursor };
}

export function mergeLiveContacts(
  contacts: readonly DmContactInput[],
  events: readonly InboxEventInput[],
  pairUnreads: readonly PairUnreadInput[] = [],
  selfUid = "",
): DmContactInput[] {
  const me = selfUid.trim();
  const inbound = events.filter((event) => {
    const from = (event.fromPersonUid ?? "").trim();
    return from && from !== me;
  });
  const merged = mergeContactsWithInbox(contacts, inbound, pairUnreads);
  const seen = new Set(merged.map((row) => row.personUid));
  const extras: DmContactInput[] = [];
  for (const row of pairUnreads) {
    const uid = (row.withPersonUid ?? "").trim();
    if (!uid || uid === me || seen.has(uid)) continue;
    seen.add(uid);
    extras.push({
      personUid: uid,
      lastActivityAt: null,
      unreadCount: typeof row.unreadCount === "number" ? row.unreadCount : null,
    });
  }
  return extras.length > 0 ? [...merged, ...extras] : merged;
}

export function parseWorkFeed(raw: unknown): WorkFeedItem[] {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const legacyList = [
    ...(Array.isArray(rec?.open) ? rec.open : []),
    ...(Array.isArray(rec?.changed) ? rec.changed : []),
  ];
  // contractVersion-2 snapshots are authoritative. Do not mix their items
  // with legacy open/changed rows, which can otherwise duplicate stale data.
  const source = Array.isArray(rec?.items)
    ? rec.items
    : legacyList.length > 0
      ? legacyList
      : Array.isArray(raw)
        ? raw
        : [];
  const out: WorkFeedItem[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const projectId = projectIdFromWorkRow(row);
    if (!projectId) continue;
    out.push({
      projectId,
      companyUid: typeof row.companyUid === "string" ? row.companyUid : null,
      lastActivityAt:
        typeof row.lastActivityAt === "string" ? row.lastActivityAt : null,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      threadStatus:
        typeof row.threadStatus === "string" ? row.threadStatus : null,
      progressSummary:
        typeof row.progressSummary === "string" ? row.progressSummary : null,
      ownerUid: typeof row.ownerUid === "string" ? row.ownerUid : null,
      threadId:
        typeof row.threadId === "string"
          ? row.threadId
          : typeof row.id === "string"
            ? row.id
            : null,
    });
  }
  return out;
}

function parseIso(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function sameStamp(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ta = parseIso(a);
  const tb = parseIso(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) < 2000;
}

function projectIdFromWorkRow(row: Record<string, unknown>): string {
  const direct = row.projectId ?? row.project_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof row.project === "string" && row.project.trim()) {
    return row.project.trim();
  }
  const routing =
    row.routing &&
    typeof row.routing === "object" &&
    !Array.isArray(row.routing)
      ? (row.routing as { tags?: unknown })
      : null;
  const tags = Array.isArray(routing?.tags) ? routing.tags : [];
  for (const tag of tags) {
    const text = String(tag);
    if (text.startsWith("project:") && text.length > 8) {
      return text.slice(8).trim();
    }
  }
  return "";
}

function projectKeysForRow(row: ChannelDirectoryRow): string[] {
  const keys: string[] = [];
  const push = (value: string | null | undefined) => {
    const text = (value ?? "").trim().toLowerCase();
    if (text && !keys.includes(text)) keys.push(text);
  };
  push(row.projectId);
  push(row.channelId);
  const name = (row.name ?? "").trim();
  const named = name.match(/^project\s+(.+?)\s+[0-9a-f]{6,}$/i);
  if (named?.[1]) push(named[1]);
  return keys;
}

function workItemsForProject(
  items: readonly WorkFeedItem[],
  row: ChannelDirectoryRow,
): WorkFeedItem[] {
  const keys = new Set(projectKeysForRow(row));
  if (keys.size === 0) return [];
  return items.filter((item) => keys.has(item.projectId.toLowerCase()));
}

function newestIso(values: Array<string | null | undefined>): string | null {
  const ok = values.filter((value): value is string =>
    Boolean(value && Number.isFinite(Date.parse(value))),
  );
  if (ok.length === 0) return null;
  return ok.sort().at(-1) ?? null;
}

/**
 * Newest real activity, else created-on. Ignore doctor/ensure clones where
 * lastActivityAt === updatedAt. Never prefer an old createdAt over a newer
 * lastActivityAt.
 */
export function honestRowActivityAt(
  row: ChannelDirectoryRow,
  items: readonly WorkFeedItem[] = [],
): string | null {
  const isProject =
    row.scope === "project" || row.type === "project" || Boolean(row.projectId);
  if (!isProject) {
    return row.lastActivityAt ?? row.createdAt ?? null;
  }
  const mine = workItemsForProject(items, row);
  const directoryLast =
    row.lastActivityAt && !sameStamp(row.lastActivityAt, row.updatedAt)
      ? row.lastActivityAt
      : null;
  const activity = newestIso([
    directoryLast,
    ...mine.map((item) => item.lastActivityAt),
  ]);
  if (activity) return activity;
  const birth =
    row.createdAt && !sameStamp(row.createdAt, row.updatedAt)
      ? row.createdAt
      : (mine
          .map((item) => item.createdAt)
          .filter((value): value is string => Boolean(value))
          .sort()[0] ?? null);
  return birth ?? row.createdAt ?? row.lastActivityAt ?? null;
}

export function applyHonestDirectoryActivity(
  rows: ChannelDirectoryRow[],
  items: readonly WorkFeedItem[],
  previous: readonly ChannelDirectoryRow[] = [],
): ChannelDirectoryRow[] {
  const prevById = new Map(previous.map((row) => [row.channelId, row]));
  return rows.map((row) => {
    const next = honestRowActivityAt(row, items);
    const prev = prevById.get(row.channelId)?.lastActivityAt;
    const provisionClone =
      Boolean(next) &&
      sameStamp(row.lastActivityAt, row.updatedAt) &&
      sameStamp(row.createdAt, row.updatedAt) &&
      sameStamp(next, row.createdAt);
    const prevMs = parseIso(prev);
    const nextMs = parseIso(next);
    const prevIsStale =
      Number.isFinite(prevMs) &&
      Number.isFinite(nextMs) &&
      nextMs - prevMs > 14 * 86_400_000;
    if (provisionClone && prev && !prevIsStale) {
      return { ...row, lastActivityAt: prev };
    }
    if (next) return { ...row, lastActivityAt: next };
    return { ...row, lastActivityAt: prev ?? next };
  });
}

/**
 * Work-mesh `/work` is metadata for existing notify channels (dates, board).
 * Do not mint sidebar rows from it — those slugs are not desktop channels.
 */
export function mergeWorkProjectsIntoDirectory(
  rows: ChannelDirectoryRow[],
  items: readonly WorkFeedItem[] = [],
): ChannelDirectoryRow[] {
  return applyHonestDirectoryActivity(rows, items, rows);
}

export function workItemsAsChannels(
  items: readonly WorkFeedItem[],
  companyUid: string,
): Channel[] {
  const latest = new Map<string, WorkFeedItem>();
  for (const item of items) {
    if (item.companyUid && item.companyUid !== companyUid) continue;
    const prev = latest.get(item.projectId);
    if (
      !prev ||
      String(item.lastActivityAt ?? "") > String(prev.lastActivityAt ?? "")
    ) {
      latest.set(item.projectId, item);
    }
  }
  return [...latest.values()].map((item) => ({
    channelId: item.projectId,
    name: item.projectId,
    scope: "project",
    companyUid: item.companyUid,
    projectId: item.projectId,
    lastActivityAt: item.lastActivityAt,
    unread: 0,
  }));
}

const BOARD_COLUMNS = [
  {
    id: "in_progress",
    title: "Doing",
    statuses: ["in-progress", "progress", "claimed"],
  },
  {
    id: "review",
    title: "Waiting",
    statuses: ["needs-human", "needs_human", "review"],
  },
  { id: "queued", title: "To do", statuses: ["open", "queued", "todo"] },
  { id: "done", title: "Done", statuses: ["done", "reconciled"] },
] as const;

function boardColumnId(status: string | null | undefined): string {
  const raw = (status ?? "").toLowerCase();
  for (const col of BOARD_COLUMNS) {
    if ((col.statuses as readonly string[]).includes(raw)) return col.id;
  }
  if (raw === "blocked") return "review";
  return "queued";
}

/** Map person work-feed rows. Not the project Board (that is PROJECT_VIEW). */
export function boardFromWorkItems(
  projectId: string,
  items: readonly WorkFeedItem[],
): BoardTabData | null {
  const needle = projectId.trim().toLowerCase();
  if (!needle) return null;
  const mine = items.filter((item) => item.projectId.toLowerCase() === needle);
  if (mine.length === 0) return null;
  const columns = BOARD_COLUMNS.map((col) => ({
    id: col.id,
    title: col.title,
    cards: [] as Array<{ storyId: string; label: string; statusLine: string }>,
  }));
  const stories: BoardTabData["stories"] = {};
  for (const item of mine) {
    const col = boardColumnId(item.threadStatus);
    const id =
      item.threadId || `${item.projectId}:${item.lastActivityAt ?? ""}`;
    const label = (item.progressSummary ?? "").trim() || item.projectId;
    const statusLine = (item.threadStatus ?? "open")
      .replace(/-/g, " ")
      .toUpperCase();
    columns
      .find((c) => c.id === col)
      ?.cards.push({
        storyId: id,
        label,
        statusLine,
      });
    stories[id] = {
      id,
      title: label,
      statusBadge: statusLine,
      description: item.progressSummary ?? "",
      fields: {
        status: statusLine,
        assignee: item.ownerUid ?? "",
        project: item.projectId,
        branch: "",
      },
      acceptanceCriteria: [],
      acCountLabel: "0 / 0",
      activity: item.lastActivityAt
        ? [
            {
              id: "updated",
              at: item.lastActivityAt,
              text: "Work-mesh thread updated",
            },
          ]
        : [],
    };
  }
  return { columns, stories };
}

export function projectIdFromDirectoryRow(row: {
  projectId?: string | null;
  channelId?: string | null;
  title?: string;
}): string | null {
  const explicit = (row.projectId ?? "").trim();
  if (explicit) return explicit;
  const channelId = (row.channelId ?? "").trim();
  if (channelId && !channelId.startsWith("chn_")) return channelId;
  return null;
}
