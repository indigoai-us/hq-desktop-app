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

export function contextPromptForThread(thread: SessionThread): string {
  if (thread.origin.kind === "message") {
    return [
      `Continue this work in the current project channel.`,
      ``,
      `${thread.origin.author} wrote:`,
      `> ${thread.origin.excerpt.replace(/\n/g, "\n> ")}`,
      ``,
      `Work that request. Stay in this session.`,
    ].join("\n");
  }
  return [
    `A session was started from #${thread.origin.channelTitle}.`,
    `Work in this project. Ask if the next step is unclear.`,
  ].join("\n");
}
