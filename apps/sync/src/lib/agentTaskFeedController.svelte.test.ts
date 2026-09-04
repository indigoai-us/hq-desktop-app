import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTaskFeedController } from './agentTaskFeedController.svelte';

const roster = [
  { personUid: 'prs_human', displayName: 'Corey' },
  { personUid: 'agt_one', displayName: 'Maggie' },
  { personUid: 'agt_two', displayName: 'Jarvis' },
];

const payloadFor = (uid: string) => ({
  running: { count: 1, tasks: [{ taskId: `${uid}-run`, title: `Run for ${uid}` }] },
  queued: { count: 0, tasks: [] },
  recentTerminal: [],
});

/** Let queued microtasks (the constructor's first tick) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('AgentTaskFeedController', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('polls only the agents on the roster, never the humans', async () => {
    const fetch = vi.fn(async (uid: string) => payloadFor(uid));
    const ctl = new AgentTaskFeedController(async () => roster, fetch, 60_000);
    await settle();
    expect(fetch.mock.calls.map((c) => c[0]).sort()).toEqual(['agt_one', 'agt_two']);
    ctl.dispose();
  });

  it('flattens every agent feed into one task list', async () => {
    const ctl = new AgentTaskFeedController(async () => roster, async (uid) => payloadFor(uid), 60_000);
    await settle();
    expect(ctl.tasks.map((t) => t.id).sort()).toEqual(['agt_one-run', 'agt_two-run']);
    expect(ctl.tasks.every((t) => t.status === 'working')).toBe(true);
    ctl.dispose();
  });

  it('fetches nothing for a roster with no agents', async () => {
    const fetch = vi.fn(async (uid: string) => payloadFor(uid));
    const ctl = new AgentTaskFeedController(async () => [roster[0]], fetch, 60_000);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(ctl.tasks).toEqual([]);
    ctl.dispose();
  });

  it('keeps one agent failing from hiding the others', async () => {
    const fetch = async (uid: string) => {
      if (uid === 'agt_two') throw new Error('forbidden 403');
      return payloadFor(uid);
    };
    const ctl = new AgentTaskFeedController(async () => roster, fetch, 60_000);
    await settle();
    expect(ctl.tasks.map((t) => t.id)).toEqual(['agt_one-run']);
    expect(ctl.feeds.get('agt_two')?.error).toBe('forbidden 403');
    expect(ctl.feeds.get('agt_two')?.tasks).toEqual([]);
    ctl.dispose();
  });

  it('treats a roster load failure as no agents, not a crash', async () => {
    const fetch = vi.fn(async (uid: string) => payloadFor(uid));
    const ctl = new AgentTaskFeedController(async () => { throw new Error('offline'); }, fetch, 60_000);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(ctl.tasks).toEqual([]);
    ctl.dispose();
  });

  it('caches the roster instead of reloading it every tick', async () => {
    const getMembers = vi.fn(async () => roster);
    const ctl = new AgentTaskFeedController(getMembers, async (uid) => payloadFor(uid), 1_000);
    await settle();
    await ctl.tick();
    await ctl.tick();
    expect(getMembers).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });

  it('stops polling and ignores late results after dispose', async () => {
    const fetch = vi.fn(async (uid: string) => payloadFor(uid));
    const ctl = new AgentTaskFeedController(async () => roster, fetch, 1_000);
    await settle();
    const before = fetch.mock.calls.length;
    ctl.dispose();
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(fetch.mock.calls.length).toBe(before);
    // A tick after dispose is a no-op: it neither fetches nor mutates.
    const frozen = ctl.tasks.map((t) => t.id);
    await ctl.tick();
    expect(fetch.mock.calls.length).toBe(before);
    expect(ctl.tasks.map((t) => t.id)).toEqual(frozen);
  });
});
