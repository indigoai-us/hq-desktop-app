/**
 * Agent task feed — pure normalization of the hq-pro task payload.
 *
 * Wire source: `GET /v1/agent-telescope/agents/{agentUid}/tasks`, proxied by the
 * `list_agent_tasks` Tauri command. Same split as team-telemetry.ts: the Rust
 * side owns auth and transport, this module owns shape, and the component just
 * renders. Kept rune-free so it is trivially unit-testable.
 *
 * What the payload can and cannot tell us, honestly:
 *
 *  - `running.tasks[]` and `queued.tasks[]` are the live rows. They carry a
 *    taskId, usually a title, and sometimes an age.
 *  - `recentTerminal[]` is the ONE durable terminal signal the heartbeat keeps.
 *    Everything else that finishes simply disappears from the next beat, so
 *    this feed can never show a full history of completed work.
 *  - The payload is agent-scoped, not conversation-scoped. There is no
 *    conversation key anywhere in it.
 *
 * We therefore never invent a status, an age, or a completion. A row missing a
 * title falls back to its own id rather than to invented prose.
 */

import type { AgentTask, AgentTaskStatus } from './agent-tasks';

/** A single row as it arrives on the wire. */
interface WireTaskRow {
  taskId?: unknown;
  title?: unknown;
  ageSeconds?: unknown;
}

export interface AgentTaskFeed {
  tasks: AgentTask[];
  /** Server-reported counts, kept separate — they can exceed the rows shown. */
  runningCount: number | null;
  queuedCount: number | null;
  /** Age of the beat this view was derived from; null when unknown. */
  lastHeartbeatAgeSeconds: number | null;
  /** True when the payload parsed but carried no rows at all. */
  empty: boolean;
  /** Transport/permission message for the UI; null when fine. */
  error: string | null;
}

const EMPTY: AgentTaskFeed = {
  tasks: [],
  runningCount: null,
  queuedCount: null,
  lastHeartbeatAgeSeconds: null,
  empty: true,
  error: null,
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Titles are user-supplied text off an agent box — bound them before display. */
const MAX_TITLE_CHARS = 120;

function safeTitle(raw: unknown, fallbackId: string): string {
  const title = str(raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return title.length > 0 ? title : fallbackId;
}

function rowsOf(value: unknown): WireTaskRow[] {
  return Array.isArray(value) ? (value as WireTaskRow[]) : [];
}

function toTask(row: WireTaskRow, status: AgentTaskStatus): AgentTask | null {
  const id = str(row?.taskId);
  if (id === '') return null; // no id means no stable mark — drop the row
  return { id, title: safeTitle(row?.title, id), status };
}

/**
 * Normalize a raw payload into the feed.
 *
 * @param payload the JSON object returned by `list_agent_tasks`
 * @param error   a transport/permission failure, if the call did not succeed
 */
export function agentTaskFeed(payload: unknown, error?: string | null): AgentTaskFeed {
  if (error) return { ...EMPTY, error };
  if (payload === null || typeof payload !== 'object') return EMPTY;

  const body = payload as Record<string, unknown>;
  const running = body.running as Record<string, unknown> | undefined;
  const queued = body.queued as Record<string, unknown> | undefined;

  const tasks: AgentTask[] = [];
  for (const row of rowsOf(running?.tasks)) {
    const task = toTask(row, 'working');
    if (task) tasks.push(task);
  }
  for (const row of rowsOf(queued?.tasks)) {
    const task = toTask(row, 'queued');
    if (task) tasks.push(task);
  }
  // The single durable terminal signal the heartbeat carries. Not a history.
  for (const row of rowsOf(body.recentTerminal)) {
    const task = toTask(row, 'failed');
    if (task) tasks.push(task);
  }

  // A task can appear in more than one bucket across a beat boundary; the
  // first occurrence wins so a live row is never replaced by a stale one.
  const seen = new Set<string>();
  const deduped = tasks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return {
    tasks: deduped,
    runningCount: num(running?.count),
    queuedCount: num(queued?.count),
    lastHeartbeatAgeSeconds: num(body.lastHeartbeatAgeSeconds),
    empty: deduped.length === 0,
    error: null,
  };
}
