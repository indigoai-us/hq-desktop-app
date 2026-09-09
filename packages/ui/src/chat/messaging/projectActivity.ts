/**
 * Project-channel work-mesh activity — the join the desktop app was missing.
 *
 * A project channel has TWO sources of truth and, before this module, rendered
 * only one of them:
 *
 *   1. chat messages          GET /v1/notify/channels/{id}/messages
 *   2. work-mesh thread events GET /v1/work-mesh/threads[/{id}/events]
 *
 * Nothing joined them, so a project with a live claim + progress trail showed
 * "No messages yet". This module turns work-mesh events into ordinary timeline
 * entries so the existing `ChannelConversation` row dispatch renders them with
 * no changes to the timeline component: each entry's body is the legacy
 * `work-session-event` JSON envelope that `parseWorkSessionEvent` already
 * understands, and the row it produces is `WorkMeshActivityRow`.
 *
 * Envelope-agnostic by construction: `normalizeWorkMeshEvent` accepts v1
 * `WORK_THREAD_EVENT` rows (live in production today) and v2 Work Mesh Live
 * session events (hq-pro #2990, dark behind `workMeshLiveEnabled`), so the
 * timeline is correct before, during, and after that rollout.
 */

import type { ConversationMessageWire } from "../chat-api";
import {
  normalizeWorkMeshEvent,
  type NormalizeContext,
  type WorkSessionActivity,
} from "./workSessionEvent";

/** Default burst window: consecutive same-actor/same-kind events inside 5 min. */
export const BURST_WINDOW_MS = 5 * 60 * 1000;

/** Synthetic event-id prefix, so activity rows can never collide with chat. */
export const ACTIVITY_EVENT_PREFIX = "wm:";

/** One page of `GET /v1/work-mesh/threads`. */
export interface ThreadPage {
  threads: readonly unknown[];
  nextCursor?: string | null;
}

/** Pages to walk when the server has not yet learned the `projectId` filter. */
export const MAX_THREAD_PAGES = 6;

function threadProjectId(thread: unknown): string | null {
  if (!thread || typeof thread !== "object") return null;
  const row = thread as {
    projectId?: unknown;
    routing?: { tags?: unknown } | null;
  };
  if (typeof row.projectId === "string" && row.projectId.trim()) {
    return row.projectId.trim();
  }
  // Pre-projectId-on-META threads carry `project:{id}` in their routing tags.
  const tags = row.routing?.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === "string" && tag.startsWith("project:")) {
        const id = tag.slice("project:".length).trim();
        if (id) return id;
      }
    }
  }
  return null;
}

function threadIdOf(thread: unknown): string | null {
  if (!thread || typeof thread !== "object") return null;
  const id = (thread as { threadId?: unknown }).threadId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Collect one project's thread ids.
 *
 * `GET /v1/work-mesh/threads` gained a server-side `projectId` filter (hq-pro,
 * additive) but until that is deployed the parameter is IGNORED and the route
 * returns the paginated company-wide list — mostly `reconciled` work-session
 * rows with no project at all. So this ALWAYS filters client-side, and pages
 * (bounded) while a cursor comes back. Once the server filter is live the first
 * page carries no cursor and the loop exits immediately.
 */
export async function collectProjectThreadIds(
  projectId: string,
  fetchPage: (cursor?: string) => Promise<ThreadPage | null>,
  maxThreads: number,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    if (!result) break;
    for (const thread of result.threads ?? []) {
      if (threadProjectId(thread) !== projectId) continue;
      const id = threadIdOf(thread);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= maxThreads) return ids;
    }
    cursor = result.nextCursor?.trim() || undefined;
    if (!cursor) break;
  }
  return ids;
}

export interface ThreadEventsInput {
  threadId: string;
  events: readonly unknown[];
}

function timeOf(activity: WorkSessionActivity): number {
  if (!activity.at) return 0;
  const ms = Date.parse(activity.at);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Normalise every event of every thread into one time-ordered activity list.
 *
 * Dedupes on `eventId` (MQTT is at-least-once and a catch-up fetch overlaps the
 * live stream), drops anything unparseable, and sorts oldest → newest to match
 * the channel timeline's own order.
 */
export function projectActivityEntries(
  threads: readonly ThreadEventsInput[],
  ctx: NormalizeContext = {},
): WorkSessionActivity[] {
  const byId = new Map<string, WorkSessionActivity>();
  const anonymous: WorkSessionActivity[] = [];

  for (const thread of threads) {
    for (const raw of thread.events ?? []) {
      const activity = normalizeWorkMeshEvent(raw, {
        ...ctx,
        threadId: thread.threadId,
      });
      if (!activity) continue;
      if (activity.eventId) {
        if (!byId.has(activity.eventId)) byId.set(activity.eventId, activity);
      } else {
        anonymous.push(activity);
      }
    }
  }

  return [...byId.values(), ...anonymous].sort((a, b) => {
    const delta = timeOf(a) - timeOf(b);
    if (delta !== 0) return delta;
    return (a.eventId ?? "").localeCompare(b.eventId ?? "");
  });
}

/**
 * Collapse bursts: consecutive entries with the same actor AND the same kind
 * inside `windowMs` become one row carrying `burstCount`, keeping the LAST
 * event's summary (the newest state is the interesting one) and its timestamp.
 *
 * `blocked` and `task_status` are never collapsed — each one is a distinct fact
 * a reader needs to see.
 */
export function groupActivityBursts(
  entries: readonly WorkSessionActivity[],
  windowMs: number = BURST_WINDOW_MS,
): WorkSessionActivity[] {
  const out: WorkSessionActivity[] = [];
  for (const entry of entries) {
    const prev = out[out.length - 1];
    const collapsible = entry.kind !== "blocked" && entry.kind !== "task_status";
    if (
      prev &&
      collapsible &&
      prev.kind === entry.kind &&
      prev.actor === entry.actor &&
      prev.actorUid === entry.actorUid &&
      timeOf(entry) - timeOf(prev) <= windowMs
    ) {
      out[out.length - 1] = {
        ...entry,
        burstCount: (prev.burstCount ?? 1) + 1,
      };
      continue;
    }
    out.push({ ...entry, burstCount: entry.burstCount ?? 1 });
  }
  return out;
}

/** The legacy envelope `parseWorkSessionEvent` reads back out of a message body. */
function activityBody(activity: WorkSessionActivity): string {
  return JSON.stringify({
    kind: "work-session-event",
    threadId: activity.threadId,
    eventId: activity.eventId,
    event: {
      kind: activity.kind,
      by: activity.actor,
      byUid: activity.actorUid,
      actorType: activity.actorType,
      at: activity.at,
      summary: activity.summary,
      harness: activity.harness,
    },
    payload: {
      storyId: activity.storyId,
      storyTitle: activity.storyTitle,
      taskId: activity.taskStatus?.taskId ?? activity.storyId,
      status: activity.taskStatus?.to,
      previousStatus: activity.taskStatus?.from,
      doneCriteria: activity.doneCriteria,
      branch: activity.branch,
      runtime: activity.runtime,
      harness: activity.harness,
    },
  });
}

/**
 * Render activity as timeline messages the channel view already knows how to
 * draw. `direction: "in"` and a synthetic `wm:` event id keep them out of the
 * unread/reaction/reply paths — these rows are not chat and are never sendable.
 */
export function activityTimelineMessages(
  entries: readonly WorkSessionActivity[],
): ConversationMessageWire[] {
  return entries.map((activity, index) => ({
    eventId: `${ACTIVITY_EVENT_PREFIX}${activity.eventId ?? `${activity.threadId ?? "t"}-${index}`}`,
    fromPersonUid: activity.actorUid ?? "",
    fromDisplayName: activity.actor,
    body: activityBody(activity),
    createdAt: activity.at ?? new Date(0).toISOString(),
    direction: "in" as const,
  }));
}

/** True for a timeline entry this module synthesised. */
export function isActivityMessage(message: { eventId?: string }): boolean {
  return Boolean(message.eventId?.startsWith(ACTIVITY_EVENT_PREFIX));
}

/**
 * Merge chat messages and activity rows into one oldest→newest timeline.
 * Stable for equal timestamps: chat wins the tie so a reply stays under the
 * message it answers.
 */
export function mergeActivityIntoTimeline(
  chat: readonly ConversationMessageWire[],
  activity: readonly ConversationMessageWire[],
): ConversationMessageWire[] {
  if (activity.length === 0) return [...chat];
  const rank = (m: ConversationMessageWire): number => {
    const ms = Date.parse(m.createdAt ?? "");
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...chat, ...activity].sort((a, b) => {
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    const aIsActivity = isActivityMessage(a) ? 1 : 0;
    const bIsActivity = isActivityMessage(b) ? 1 : 0;
    return aIsActivity - bIsActivity;
  });
}
