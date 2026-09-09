/**
 * Room task feed — pure normalization of the room-scoped task payload.
 *
 * Wire source: `GET /v1/agent-telescope/agents/{agentUid}/channels/{channelId}/tasks`,
 * proxied by the `list_channel_agent_tasks` Tauri command. Sibling of
 * agent-task-feed.ts, which normalizes the agent-wide heartbeat view; this one
 * is the ROOM-scoped view sourced from the interaction trace.
 *
 * What it can say that the heartbeat view cannot: these are the tasks spawned
 * from messages in THIS room, and finished tasks are retained (for the trace
 * retention window) rather than dropping out of the next heartbeat.
 *
 * Same discipline as its sibling: never invent a status, a title, or a
 * completion. Rows without an id are dropped (no id, no stable mark); rows
 * without a title fall back to the id; titles are control-stripped and bounded.
 */

import type { AgentTask, AgentTaskStatus } from './agent-tasks';

interface WireRoomTask {
  taskId?: unknown;
  title?: unknown;
  status?: unknown;
  originMessageId?: unknown;
  lastEventAt?: unknown;
}

export interface RoomTaskFeed {
  tasks: AgentTask[];
  /** True when the payload parsed but carried no rows. */
  empty: boolean;
  /** Transport/permission message; null when fine. */
  error: string | null;
}

const EMPTY: RoomTaskFeed = { tasks: [], empty: true, error: null };

const STATUSES: ReadonlySet<string> = new Set<AgentTaskStatus>([
  'queued', 'working', 'waiting', 'done', 'failed',
]);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const MAX_TITLE_CHARS = 120;
function safeTitle(raw: unknown, fallbackId: string): string {
  const title = str(raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return title.length > 0 ? title : fallbackId;
}

function toTask(row: WireRoomTask): AgentTask | null {
  const id = str(row?.taskId);
  if (id === '') return null;
  const status = str(row?.status);
  // The server only emits statuses in our vocabulary; an unknown one means a
  // contract drift we would rather notice than paper over — drop the row.
  if (!STATUSES.has(status)) return null;
  const task: AgentTask = { id, title: safeTitle(row?.title, id), status: status as AgentTaskStatus };
  const origin = str(row?.originMessageId);
  if (origin) task.originMessageId = origin;
  const at = str(row?.lastEventAt);
  if (at && !Number.isNaN(Date.parse(at))) task.lastEventAt = at;
  return task;
}

/** Normalize a raw `list_channel_agent_tasks` payload. */
export function roomTaskFeed(payload: unknown, error?: string | null): RoomTaskFeed {
  if (error) return { ...EMPTY, error };
  if (payload === null || typeof payload !== 'object') return EMPTY;
  const rows = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(rows)) return EMPTY;

  const seen = new Set<string>();
  const tasks: AgentTask[] = [];
  for (const row of rows as WireRoomTask[]) {
    const task = toTask(row);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  return { tasks, empty: tasks.length === 0, error: null };
}
