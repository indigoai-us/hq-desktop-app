import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTaskFeedController } from './agentTaskFeedController.svelte';

const roster = [
  { personUid: 'prs_human', displayName: 'Corey' },
  { personUid: 'agt_one', displayName: 'Maggie' },
  { personUid: 'agt_two', displayName: 'Jarvis' },
];

const agentPayload = (uid: string) => ({
  running: { count: 1, tasks: [{ taskId: `${uid}-run`, title: `Run for ${uid}` }] },
  queued: { count: 0, tasks: [] },
  recentTerminal: [],
});
const roomPayload = (uid: string, channelId: string) => ({
  agentUid: uid,
  channelId,
  tasks: [{ taskId: `${uid}-room`, title: `Room task for ${uid}`, status: 'done' }],
});

/** Let queued microtasks (the constructor's first tick) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('AgentTaskFeedController', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('polls only the agents on the roster, never the humans', async () => {
    const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
    const ctl = new AgentTaskFeedController(async () => roster, { fetchTasks, pollMs: 60_000 });
    await settle();
    expect(fetchTasks.mock.calls.map((c) => c[0]).sort()).toEqual(['agt_one', 'agt_two']);
    ctl.dispose();
  });

  it('flattens every agent feed into one task list', async () => {
    const ctl = new AgentTaskFeedController(async () => roster, {
      fetchTasks: async (uid) => agentPayload(uid),
      pollMs: 60_000,
    });
    await settle();
    expect(ctl.tasks.map((t) => t.id).sort()).toEqual(['agt_one-run', 'agt_two-run']);
    ctl.dispose();
  });

  it('fetches nothing for a roster with no agents', async () => {
    const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
    const ctl = new AgentTaskFeedController(async () => [roster[0]], { fetchTasks, pollMs: 60_000 });
    await settle();
    expect(fetchTasks).not.toHaveBeenCalled();
    expect(ctl.tasks).toEqual([]);
    ctl.dispose();
  });

  it('keeps one agent failing from hiding the others', async () => {
    const ctl = new AgentTaskFeedController(async () => roster, {
      fetchTasks: async (uid) => {
        if (uid === 'agt_two') throw new Error('forbidden 403');
        return agentPayload(uid);
      },
      pollMs: 60_000,
    });
    await settle();
    expect(ctl.tasks.map((t) => t.id)).toEqual(['agt_one-run']);
    expect(ctl.feeds.get('agt_two')?.error).toBe('forbidden 403');
    ctl.dispose();
  });

  it('treats a roster load failure as no agents, not a crash', async () => {
    const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
    const ctl = new AgentTaskFeedController(async () => { throw new Error('offline'); }, { fetchTasks, pollMs: 60_000 });
    await settle();
    expect(fetchTasks).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it('caches the roster instead of reloading it every tick', async () => {
    const getMembers = vi.fn(async () => roster);
    const ctl = new AgentTaskFeedController(getMembers, { fetchTasks: async (uid) => agentPayload(uid), pollMs: 1_000 });
    await settle();
    await ctl.tick();
    await ctl.tick();
    expect(getMembers).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });

  it('stops polling and ignores late ticks after dispose', async () => {
    const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
    const ctl = new AgentTaskFeedController(async () => roster, { fetchTasks, pollMs: 1_000 });
    await settle();
    const before = fetchTasks.mock.calls.length;
    ctl.dispose();
    vi.advanceTimersByTime(5_000);
    await settle();
    const frozen = ctl.tasks.map((t) => t.id);
    await ctl.tick();
    expect(fetchTasks.mock.calls.length).toBe(before);
    expect(ctl.tasks.map((t) => t.id)).toEqual(frozen);
  });

  describe('room scope', () => {
    it('prefers the room-scoped route when a channelId is given', async () => {
      const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
      const fetchRoomTasks = vi.fn(async (uid: string, ch: string) => roomPayload(uid, ch));
      const ctl = new AgentTaskFeedController(async () => roster, {
        channelId: 'chn_room1', fetchTasks, fetchRoomTasks, pollMs: 60_000,
      });
      await settle();
      expect(fetchRoomTasks.mock.calls.map((c) => c[1])).toEqual(['chn_room1', 'chn_room1']);
      expect(fetchTasks).not.toHaveBeenCalled();
      expect(ctl.tasks.map((t) => [t.id, t.status]).sort()).toEqual([
        ['agt_one-room', 'done'],
        ['agt_two-room', 'done'],
      ]);
      expect(ctl.sources.get('agt_one')).toBe('room');
      ctl.dispose();
    });

    it('falls back to the agent-wide feed when the room route is unavailable', async () => {
      // The pre-rollout case: the server has not deployed the route yet and
      // answers 404 — which the command surfaces as an error.
      const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
      const fetchRoomTasks = vi.fn(async () => { throw new Error('not available for this room'); });
      const ctl = new AgentTaskFeedController(async () => roster, {
        channelId: 'chn_room1', fetchTasks, fetchRoomTasks, pollMs: 60_000,
      });
      await settle();
      expect(fetchTasks).toHaveBeenCalledTimes(2);
      expect(ctl.tasks.map((t) => t.id).sort()).toEqual(['agt_one-run', 'agt_two-run']);
      expect(ctl.sources.get('agt_one')).toBe('agent');
      expect(ctl.feeds.get('agt_one')?.error).toBeNull();
      ctl.dispose();
    });

    it('uses the agent-wide feed when no channelId is given, without touching the room route', async () => {
      const fetchRoomTasks = vi.fn(async (uid: string, ch: string) => roomPayload(uid, ch));
      const ctl = new AgentTaskFeedController(async () => roster, {
        fetchTasks: async (uid) => agentPayload(uid), fetchRoomTasks, pollMs: 60_000,
      });
      await settle();
      expect(fetchRoomTasks).not.toHaveBeenCalled();
      expect(ctl.sources.get('agt_one')).toBe('agent');
      ctl.dispose();
    });

    it('a room feed that is legitimately empty stays empty — it does not fall back', async () => {
      const fetchTasks = vi.fn(async (uid: string) => agentPayload(uid));
      const fetchRoomTasks = vi.fn(async () => ({ tasks: [] }));
      const ctl = new AgentTaskFeedController(async () => roster, {
        channelId: 'chn_room1', fetchTasks, fetchRoomTasks, pollMs: 60_000,
      });
      await settle();
      expect(fetchTasks).not.toHaveBeenCalled();
      expect(ctl.tasks).toEqual([]);
      expect(ctl.sources.get('agt_one')).toBe('room');
      ctl.dispose();
    });
  });
});
