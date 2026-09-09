/**
 * Agent task feed controller — the live source behind the task-chip strip.
 *
 * Mirrors AgentThinkingController: one instance per channel, built by the host
 * with an injected roster loader, disposed on teardown. Every tick it asks for
 * each AGENT on the roster and normalizes the replies. The strip renders
 * `tasks`; the host never talks to a command directly.
 *
 * Two sources, in order of preference:
 *
 *  1. ROOM-scoped (`list_channel_agent_tasks`, when the host supplies a
 *     channelId): the tasks the agent spawned from messages in THIS room,
 *     sourced from the interaction trace, terminal states retained.
 *  2. Agent-wide (`list_agent_tasks`): the heartbeat snapshot. Used when no
 *     channelId is given, or when the room route is unavailable — which is
 *     deliberately how a server that has not yet deployed the route presents
 *     (its 404 is indistinguishable from "no access" by design). Falling back
 *     keeps the v1 behaviour intact during rollout.
 *
 * Polling, not push: the upstream data changes on the order of a minute, so a
 * 15s tick is already generous. Nothing is fetched for a roster with no agents.
 *
 * Every dependency is injectable so the class is unit-testable with no Tauri
 * runtime and no mocking — the defaults wire the real `invoke`.
 */

import { invoke } from '@tauri-apps/api/core';
import { agentTaskFeed, roomTaskFeed, type AgentTask, type AgentTaskFeed } from '@hq/ui';
import { memberKindFromUid } from '../desktop-alt/lib/team-telemetry';

export interface RosterMember {
  personUid: string;
  displayName: string;
}

export type TaskFetcher = (agentUid: string) => Promise<unknown>;
export type RoomTaskFetcher = (agentUid: string, channelId: string) => Promise<unknown>;

export interface AgentTaskFeedOptions {
  /** When set, room-scoped tasks are preferred for this channel. */
  channelId?: string | null;
  fetchTasks?: TaskFetcher;
  fetchRoomTasks?: RoomTaskFetcher;
  pollMs?: number;
}

export const AGENT_TASK_POLL_MS = 15_000;

const defaultFetch: TaskFetcher = (agentUid) =>
  invoke<unknown>('list_agent_tasks', { agentUid });
const defaultRoomFetch: RoomTaskFetcher = (agentUid, channelId) =>
  invoke<unknown>('list_channel_agent_tasks', { agentUid, channelId });

/** Which source produced an agent's rows — surfaced for diagnosis, not UI. */
export type TaskFeedSource = 'room' | 'agent';

export class AgentTaskFeedController {
  /** Per-agent feeds, keyed by agent uid. Reactive. */
  feeds = $state<Map<string, AgentTaskFeed>>(new Map());
  /** Per-agent source that produced the current rows. Reactive. */
  sources = $state<Map<string, TaskFeedSource>>(new Map());

  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private cachedAgents: string[] | null = null;
  private readonly channelId: string | null;
  private readonly fetchTasks: TaskFetcher;
  private readonly fetchRoomTasks: RoomTaskFetcher;
  private readonly pollMs: number;

  constructor(
    private readonly getMembers: () => Promise<RosterMember[]>,
    options: AgentTaskFeedOptions = {},
  ) {
    this.channelId = options.channelId?.trim() || null;
    this.fetchTasks = options.fetchTasks ?? defaultFetch;
    this.fetchRoomTasks = options.fetchRoomTasks ?? defaultRoomFetch;
    this.pollMs = options.pollMs ?? AGENT_TASK_POLL_MS;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  /** Every task across every agent on the roster. */
  get tasks(): AgentTask[] {
    const out: AgentTask[] = [];
    for (const feed of this.feeds.values()) out.push(...feed.tasks);
    return out;
  }

  /** Agent uids on the roster; cached after the first successful load. */
  private async agents(): Promise<string[]> {
    if (this.cachedAgents) return this.cachedAgents;
    try {
      const roster = await this.getMembers();
      this.cachedAgents = roster
        .map((m) => m.personUid)
        .filter((uid) => memberKindFromUid(uid) === 'agent');
      return this.cachedAgents;
    } catch {
      return [];
    }
  }

  /** One agent's rows: room-scoped when possible, agent-wide otherwise. */
  private async load(uid: string): Promise<{ feed: AgentTaskFeed; source: TaskFeedSource }> {
    if (this.channelId) {
      try {
        const room = roomTaskFeed(await this.fetchRoomTasks(uid, this.channelId));
        return {
          source: 'room',
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
        // Route unavailable (not deployed, or not permitted) — fall back.
      }
    }
    try {
      return { source: 'agent', feed: agentTaskFeed(await this.fetchTasks(uid)) };
    } catch (err) {
      return {
        source: 'agent',
        feed: agentTaskFeed(null, err instanceof Error ? err.message : String(err)),
      };
    }
  }

  /** One poll. Never throws; a failing agent yields an errored, empty feed. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const agents = await this.agents();
    if (agents.length === 0) return;
    const nextFeeds = new Map<string, AgentTaskFeed>();
    const nextSources = new Map<string, TaskFeedSource>();
    await Promise.all(
      agents.map(async (uid) => {
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
