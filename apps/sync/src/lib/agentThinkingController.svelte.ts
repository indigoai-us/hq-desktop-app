/**
 * Reactive controller for the agent "thinking" indicator, shared by ChannelView
 * and ThreadPanel (channel-scope threads).
 *
 * Each host creates one controller per open conversation and:
 *   - supplies a member-loader (`() => Promise<MentionCandidate[]>`) — the
 *     channel roster for a channel / channel-thread, or `[]` for a DM thread
 *     so a DM can never start a row;
 *   - calls `noteOutgoing(body)` after a successful send so @mentioned agents
 *     get a thinking row;
 *   - calls `noteIncoming(messages)` when replies land so an agent's own
 *     message clears their row;
 *   - calls `noteSendFailed()` on a send failure to drop every row (the
 *     mention never left, so the optimistic status is a lie);
 *   - calls `dispose()` on teardown to stop the tick interval.
 *
 * All pure logic lives in `agentThinking.ts` (unit-tested without a DOM); this
 * module only owns the reactive `$state`, the roster cache, and the interval.
 *
 * Loader errors are swallowed: a roster fetch failure means we simply don't
 * show an indicator (we never throw into the send path). The roster is cached
 * after the first successful load so a burst of sends doesn't re-hit
 * `list_channel_members`.
 */

import {
  type MentionCandidate,
  type ThinkingEntry,
  clearForAgents,
  detectAgentMentions,
  startThinking,
  tick,
} from './agentThinking';

const TICK_INTERVAL_MS = 5_000;

export class AgentThinkingController {
  /** Live thinking rows. Bound into `<AgentThinkingRow entries={…} />`. */
  entries = $state<ThinkingEntry[]>([]);

  private getMembers: () => Promise<MentionCandidate[]>;
  /** Cached roster from the first successful loader call. `null` until then
   * so a failed load retries next time rather than locking in an empty list. */
  private cachedMembers: MentionCandidate[] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(getMembers: () => Promise<MentionCandidate[]>) {
    this.getMembers = getMembers;
    this.timer = setInterval(() => {
      this.entries = tick(this.entries, Date.now());
    }, TICK_INTERVAL_MS);
  }

  /** Resolve the roster, caching on success. Returns `[]` (and does not
   * cache) when the loader throws — no indicator, never throw. */
  private async members(): Promise<MentionCandidate[]> {
    if (this.cachedMembers) return this.cachedMembers;
    try {
      const list = await this.getMembers();
      this.cachedMembers = list;
      return list;
    } catch {
      return [];
    }
  }

  /** Parse `body` for agent @mentions and start a thinking row for each.
   * No-op when the roster is empty or no agent was mentioned. */
  async noteOutgoing(body: string): Promise<void> {
    const roster = await this.members();
    const mentioned = detectAgentMentions(body, roster);
    if (mentioned.length === 0) return;
    const now = Date.now();
    let next = this.entries;
    for (const agent of mentioned) {
      next = startThinking(
        next,
        { agentUid: agent.personUid, agentName: agent.displayName },
        now,
      );
    }
    this.entries = next;
  }

  /** Clear thinking rows for every sender present on `messages`. Hosts pass
   * newly arrived messages (not the whole history) so a historical agent
   * message doesn't dismiss a just-started row. */
  noteIncoming(messages: Array<{ fromPersonUid?: string | null }>): void {
    const uids = messages
      .map((m) => m.fromPersonUid)
      .filter((uid): uid is string => !!uid);
    if (uids.length === 0) return;
    this.entries = clearForAgents(this.entries, uids);
  }

  /** Drop every row. The mention send failed, so the optimistic status is
   * no longer true for anyone. */
  noteSendFailed(): void {
    this.entries = [];
  }

  /** Stop the tick interval. Safe to call more than once. */
  dispose(): void {
    if (this.timer == null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
