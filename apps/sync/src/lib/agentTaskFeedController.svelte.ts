/**
 * Agent task feed controller — the live source behind the task-chip strip.
 *
 * Mirrors AgentThinkingController: one instance per channel, built by the host
 * with an injected roster loader, disposed on teardown. Every tick it asks
 * `list_agent_tasks` for each AGENT on the roster and normalizes the replies
 * through agent-task-feed.ts. The strip renders `tasks`; the host never talks
 * to the command directly.
 *
 * Polling, not push: the upstream data is a heartbeat snapshot that changes on
 * the order of a minute, so a 15s tick is already generous. Nothing is fetched
 * for a roster with no agents on it.
 *
 * Every dependency is injectable so the class is unit-testable with no Tauri
 * runtime and no mocking — the defaults wire the real `invoke`.
 */

import { invoke } from '@tauri-apps/api/core';
import { agentTaskFeed, type AgentTaskFeed } from '../desktop-alt/lib/agent-task-feed';
import type { AgentTask } from '../desktop-alt/lib/agent-tasks';
import { memberKindFromUid } from '../desktop-alt/lib/team-telemetry';

export interface RosterMember {
  personUid: string;
  displayName: string;
}

export type TaskFetcher = (agentUid: string) => Promise<unknown>;

export const AGENT_TASK_POLL_MS = 15_000;

const defaultFetch: TaskFetcher = (agentUid) =>
  invoke<unknown>('list_agent_tasks', { agentUid });

export class AgentTaskFeedController {
  /** Per-agent feeds, keyed by agent uid. Reactive. */
  feeds = $state<Map<string, AgentTaskFeed>>(new Map());

  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private cachedAgents: string[] | null = null;

  constructor(
    private readonly getMembers: () => Promise<RosterMember[]>,
    private readonly fetchTasks: TaskFetcher = defaultFetch,
    private readonly pollMs: number = AGENT_TASK_POLL_MS,
  ) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  /** Every task across every agent on the roster, live rows first. */
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

  /** One poll. Never throws; a failing agent yields an errored, empty feed. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const agents = await this.agents();
    if (agents.length === 0) return;
    const next = new Map<string, AgentTaskFeed>();
    await Promise.all(
      agents.map(async (uid) => {
        try {
          next.set(uid, agentTaskFeed(await this.fetchTasks(uid)));
        } catch (err) {
          next.set(uid, agentTaskFeed(null, err instanceof Error ? err.message : String(err)));
        }
      }),
    );
    if (!this.disposed) this.feeds = next;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
