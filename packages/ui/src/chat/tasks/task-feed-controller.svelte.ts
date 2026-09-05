// Polls the background tasks of every agent in a conversation and exposes
// them as one flat, reactive list for the task strip.
//
// Source selection per agent: the ROOM-scoped route when the conversation is
// a channel and the host provides it (tasks spawned from messages in THIS
// room; terminal states retained), otherwise the agent-wide heartbeat view
// (the DM case, and the fallback when the room route is unavailable — a 404
// is also exactly how a host that has not deployed the route presents).
//
// Never throws: a failing agent yields an errored, empty feed and the strip
// simply shows nothing for it.
import { agentTaskFeed, type AgentTaskFeed } from "./agent-task-feed";
import { roomTaskFeed } from "./room-task-feed";
import type { AgentTask } from "./agent-tasks";

export type TaskFetcher = (agentUid: string) => Promise<unknown>;
export type RoomTaskFetcher = (agentUid: string, channelId: string) => Promise<unknown>;

export interface TaskFeedControllerOptions {
  /** Agent uids to poll. Non-agent uids are ignored. */
  agentUids: readonly string[];
  /** Room id → prefer the room-scoped route for every agent. */
  channelId?: string | null;
  /** Agent-wide view; absent → that source is skipped. */
  fetchTasks?: TaskFetcher | null;
  /** Room-scoped view; absent → straight to the agent-wide view. */
  fetchRoomTasks?: RoomTaskFetcher | null;
  pollMs?: number;
}

export const AGENT_TASK_POLL_MS = 15_000;
export type TaskFeedSource = "room" | "agent";

/** Agent uid shapes across the fleet (`agt_…` today, `agent_…` legacy). */
export function isAgentUid(uid: string): boolean {
  const id = uid.trim().toLowerCase();
  return id.startsWith("agt_") || id.startsWith("agent_");
}

export class TaskFeedController {
  feeds = $state<Map<string, AgentTaskFeed>>(new Map());
  sources = $state<Map<string, TaskFeedSource>>(new Map());
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly agents: string[];
  private readonly channelId: string | null;
  private readonly fetchTasks: TaskFetcher | null;
  private readonly fetchRoomTasks: RoomTaskFetcher | null;

  constructor(options: TaskFeedControllerOptions) {
    this.agents = [...new Set(options.agentUids.filter(isAgentUid))];
    this.channelId = options.channelId?.trim() || null;
    this.fetchTasks = options.fetchTasks ?? null;
    this.fetchRoomTasks = options.fetchRoomTasks ?? null;
    const pollMs = options.pollMs ?? AGENT_TASK_POLL_MS;
    if (this.agents.length === 0 || (!this.fetchTasks && !this.fetchRoomTasks)) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), pollMs);
  }

  /**
   * Every task across every agent in the conversation, each task ONCE.
   *
   * The strip renders this as a keyed list — `{#each tasks as task (task.id)}`
   * — so a repeated id is not a cosmetic double row, it takes the whole shell
   * down with Svelte's `each_key_duplicate`. Each per-agent feed already
   * dedupes itself, but a channel polls every agent on the roster and the
   * room-scoped route reads the room's SHARED interaction trace, so one task
   * comes back under every agent that touched it. Fold those copies here.
   *
   * Iterating `this.agents` rather than `this.feeds` also pins the order:
   * `feeds` is populated by `Promise.all` callbacks, so its insertion order is
   * whichever request settled first and would reshuffle the chips every poll.
   * Roster order is stable, and the first agent holding a task wins it.
   */
  get tasks(): AgentTask[] {
    const seen = new Set<string>();
    const out: AgentTask[] = [];
    for (const uid of this.agents) {
      for (const task of this.feeds.get(uid)?.tasks ?? []) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        out.push(task);
      }
    }
    return out;
  }

  private async load(uid: string): Promise<{ feed: AgentTaskFeed; source: TaskFeedSource }> {
    if (this.channelId && this.fetchRoomTasks) {
      try {
        const room = roomTaskFeed(await this.fetchRoomTasks(uid, this.channelId));
        return {
          source: "room",
          feed: {
            tasks: room.tasks,
            runningCount: null,
            queuedCount: null,
            lastHeartbeatAgeSeconds: null,
            empty: room.empty,
            error: null,
          },
        };
      } catch {
        // Fall through to the agent-wide view (404 = route absent or unreadable).
      }
    }
    if (!this.fetchTasks) {
      return { source: "agent", feed: agentTaskFeed(null, "agent task view unavailable") };
    }
    try {
      return { source: "agent", feed: agentTaskFeed(await this.fetchTasks(uid)) };
    } catch (err) {
      return {
        source: "agent",
        feed: agentTaskFeed(null, err instanceof Error ? err.message : String(err)),
      };
    }
  }

  /** One poll. Never throws. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const nextFeeds = new Map<string, AgentTaskFeed>();
    const nextSources = new Map<string, TaskFeedSource>();
    await Promise.all(
      this.agents.map(async (uid) => {
        const { feed, source } = await this.load(uid);
        nextFeeds.set(uid, feed);
        nextSources.set(uid, source);
      }),
    );
    if (!this.disposed) {
      this.feeds = nextFeeds;
      this.sources = nextSources;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
