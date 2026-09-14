/**
 * In-channel session threads (spike).
 *
 * Same side-pane as Reply / Thread: stay in the channel, run a session beside
 * the chat. Two origins:
 *   - a message (quote it in the pane)
 *   - the channel itself (post a work-session card; click opens the pane)
 *
 * Humans and agents use the same card + pane. This module is the model only;
 * the host owns spawning a real CLI session later.
 */

export type SessionThreadActorKind = "human" | "agent";

export type SessionThreadOrigin =
  | {
      kind: "message";
      eventId: string;
      excerpt: string;
      author: string;
    }
  | {
      kind: "channel";
      channelId: string;
      channelTitle: string;
    };

export interface SessionThreadTurn {
  id: string;
  role: "user" | "assistant" | "system" | "tools";
  text: string;
}

export interface SessionThread {
  id: string;
  origin: SessionThreadOrigin;
  actorKind: SessionThreadActorKind;
  actorName: string;
  title: string;
  status: "starting" | "running" | "idle";
  startedAt: string;
  turns: SessionThreadTurn[];
  /** Live agent-session id once the host has started it. */
  liveSessionId?: string | null;
  /** Work-mesh story id this session is bound to. */
  taskId?: string | null;
  taskCreated?: boolean;
  startError?: string | null;
}

export function excerptFromBody(body: string, max = 180): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function titleForOrigin(origin: SessionThreadOrigin): string {
  if (origin.kind === "message") {
    const clip = excerptFromBody(origin.excerpt, 48);
    return clip || "Session from message";
  }
  return `Session in ${origin.channelTitle || "channel"}`;
}

export function createSessionThread(input: {
  origin: SessionThreadOrigin;
  actorKind: SessionThreadActorKind;
  actorName: string;
  now?: string;
}): SessionThread {
  const startedAt = input.now ?? new Date().toISOString();
  const id = `sess-thread-${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const turns: SessionThreadTurn[] = [];
  if (input.origin.kind === "message") {
    turns.push({
      id: `${id}-origin`,
      role: "system",
      text: `Started from ${input.origin.author}'s message.`,
    });
  } else {
    turns.push({
      id: `${id}-origin`,
      role: "system",
      text: `Started in #${input.origin.channelTitle || "channel"}.`,
    });
  }
  return {
    id,
    origin: input.origin,
    actorKind: input.actorKind,
    actorName: input.actorName,
    title: titleForOrigin(input.origin),
    status: "idle",
    startedAt,
    turns,
    liveSessionId: null,
    taskId: null,
    taskCreated: false,
  };
}

/** Mesh Board spawn ids look like `ws_spawn_<company>|<project>|<US-001>`. */
export function parseWorkMeshSpawnId(
  id: string | null | undefined,
): { project: string; taskId: string } | null {
  const raw = (id ?? "").trim();
  if (!raw.startsWith("ws_spawn_") || !raw.includes("|")) return null;
  const parts = raw.split("|");
  if (parts.length < 3) return null;
  const project = parts[1]?.trim() ?? "";
  const taskId = parts[2]?.trim() ?? "";
  if (!project || !taskId) return null;
  return { project, taskId };
}

/** True when HQ Desktop can `open()` this id as a local agent session. */
export function isDesktopLiveSessionId(id: string | null | undefined): boolean {
  const raw = (id ?? "").trim();
  if (!raw || raw.includes("|") || raw.startsWith("ws_spawn_")) return false;
  if (raw.startsWith("sess-thread-")) return false;
  return true;
}

/** Keep the latest work_session card per mesh/desktop session id. */
export function coalesceWorkSessionWires<
  T extends { eventId: string; systemEvent?: unknown },
>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const event = row.systemEvent;
    const sessionId =
      event &&
      typeof event === "object" &&
      (event as { type?: unknown }).type === "work_session"
        ? String((event as { sessionId?: unknown }).sessionId ?? "").trim()
        : "";
    if (sessionId) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
    }
    out.push(row);
  }
  return out.reverse();
}

export function contextPromptForThread(thread: SessionThread): string {
  if (thread.origin.kind === "message") {
    return thread.origin.excerpt.trim();
  }
  return `Work in #${thread.origin.channelTitle || "this channel"}.`;
}
