import { describe, it, expect } from 'vitest';
import { agentTaskFeed } from './agent-task-feed';
import { taskMark } from './agent-tasks';

/** A payload shaped like the real hq-pro agent-telescope tasks response. */
const payload = {
  agentUid: 'agt_01ABC',
  lastHeartbeatAgeSeconds: 12,
  running: {
    count: 2,
    tasks: [
      { taskId: 't-run-1', title: 'Repair auth final', ageSeconds: 90 },
      { taskId: 't-run-2', title: 'Nightly backfill' },
    ],
  },
  queued: { count: 1, tasks: [{ taskId: 't-q-1', title: 'Deploy preview #42' }] },
  recentTerminal: [{ taskId: 't-fail-1', title: 'Import contacts' }],
};

describe('agentTaskFeed', () => {
  it('maps each bucket onto the right status', () => {
    const feed = agentTaskFeed(payload);
    expect(feed.tasks.map((t) => [t.id, t.status])).toEqual([
      ['t-run-1', 'working'],
      ['t-run-2', 'working'],
      ['t-q-1', 'queued'],
      ['t-fail-1', 'failed'],
    ]);
  });

  it('keeps server counts separate from the rows shown', () => {
    const feed = agentTaskFeed(payload);
    expect(feed.runningCount).toBe(2);
    expect(feed.queuedCount).toBe(1);
    expect(feed.lastHeartbeatAgeSeconds).toBe(12);
    expect(feed.empty).toBe(false);
    expect(feed.error).toBeNull();
  });

  it('surfaces a transport error without inventing rows', () => {
    const feed = agentTaskFeed(null, 'auth: unauthorized 401');
    expect(feed.error).toBe('auth: unauthorized 401');
    expect(feed.tasks).toEqual([]);
    expect(feed.empty).toBe(true);
  });

  it.each([null, undefined, 'nope', 42, []])(
    'treats a non-object payload (%s) as empty rather than throwing',
    (bad) => {
      const feed = agentTaskFeed(bad);
      expect(feed.tasks).toEqual([]);
      expect(feed.empty).toBe(true);
      expect(feed.error).toBeNull();
    },
  );

  it('tolerates missing buckets and non-array task lists', () => {
    expect(agentTaskFeed({}).tasks).toEqual([]);
    expect(agentTaskFeed({ running: { tasks: 'nope' } }).tasks).toEqual([]);
    expect(agentTaskFeed({ running: {} , queued: {} }).empty).toBe(true);
  });

  it('drops a row with no task id — without an id there is no stable mark', () => {
    const feed = agentTaskFeed({
      running: { tasks: [{ title: 'orphan' }, { taskId: '  ' }, { taskId: 'ok', title: 'Fine' }] },
    });
    expect(feed.tasks.map((t) => t.id)).toEqual(['ok']);
  });

  it('falls back to the id when a title is missing, never to invented prose', () => {
    const feed = agentTaskFeed({ running: { tasks: [{ taskId: 't-1' }] } });
    expect(feed.tasks[0].title).toBe('t-1');
  });

  it('strips control characters out of a title and bounds its length', () => {
    const nasty = `Repair\u0007 auth\u0000 final${'x'.repeat(300)}`;
    const feed = agentTaskFeed({ running: { tasks: [{ taskId: 't-1', title: nasty }] } });
    const title = feed.tasks[0].title;
    expect(title).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith('Repair auth final')).toBe(true);
  });

  it('keeps the live row when a task appears in two buckets across a beat', () => {
    const feed = agentTaskFeed({
      running: { tasks: [{ taskId: 'dup', title: 'Live' }] },
      queued: { tasks: [{ taskId: 'dup', title: 'Stale' }] },
    });
    expect(feed.tasks).toHaveLength(1);
    expect(feed.tasks[0].status).toBe('working');
  });

  it('produces tasks the mark catalogue can render', () => {
    for (const task of agentTaskFeed(payload).tasks) {
      const mark = taskMark(task);
      expect(mark.svg).toMatch(/^<svg /);
      expect(mark.index).toBeGreaterThanOrEqual(0);
      expect(mark.index).toBeLessThan(100);
    }
  });
});
