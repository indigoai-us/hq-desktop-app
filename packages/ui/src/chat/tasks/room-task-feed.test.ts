import { describe, it, expect } from 'vitest';
import { roomTaskFeed } from './room-task-feed';

const payload = {
  agentUid: 'agt_01ABC',
  channelId: 'chn_room1',
  windowDays: 7,
  tasks: [
    { taskId: 't-1', title: 'Repair auth final', status: 'working', lastEventAt: '2026-09-04T17:01:00Z' },
    { taskId: 't-2', title: 'Nightly backfill', status: 'done', lastEventAt: '2026-09-04T16:00:00Z' },
    { taskId: 't-3', title: 'Import contacts', status: 'failed', lastEventAt: '2026-09-04T15:00:00Z' },
  ],
};

describe('roomTaskFeed', () => {
  it('carries room-scoped rows through, including terminal states', () => {
    const feed = roomTaskFeed(payload);
    expect(feed.tasks.map((t) => [t.id, t.status])).toEqual([
      ['t-1', 'working'],
      ['t-2', 'done'],
      ['t-3', 'failed'],
    ]);
    expect(feed.empty).toBe(false);
    expect(feed.error).toBeNull();
  });

  it('surfaces a transport error without inventing rows', () => {
    const feed = roomTaskFeed(null, 'not available for this room');
    expect(feed.error).toBe('not available for this room');
    expect(feed.tasks).toEqual([]);
  });

  it.each([null, 'nope', 7, [], {}, { tasks: 'x' }])('treats %s as empty, never throwing', (bad) => {
    const feed = roomTaskFeed(bad);
    expect(feed.tasks).toEqual([]);
    expect(feed.empty).toBe(true);
    expect(feed.error).toBeNull();
  });

  it('drops a row with no id, and one with a status outside the vocabulary', () => {
    const feed = roomTaskFeed({
      tasks: [
        { title: 'orphan', status: 'working' },
        { taskId: 'weird', title: 'x', status: 'exploding' },
        { taskId: 'ok', title: 'Fine', status: 'queued' },
      ],
    });
    expect(feed.tasks.map((t) => t.id)).toEqual(['ok']);
  });

  it('falls back to the id when the title is missing — the pre-rollout shape', () => {
    // Until the box fleet ships the title column the server returns title: null.
    const feed = roomTaskFeed({ tasks: [{ taskId: 't-1', title: null, status: 'working' }] });
    expect(feed.tasks[0].title).toBe('t-1');
  });

  it('strips control characters and bounds the title', () => {
    const feed = roomTaskFeed({
      tasks: [{ taskId: 't-1', title: `Repair\u0007 auth\u0000 final${'x'.repeat(300)}`, status: 'working' }],
    });
    expect(feed.tasks[0].title).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(feed.tasks[0].title.length).toBeLessThanOrEqual(120);
    expect(feed.tasks[0].title.startsWith('Repair auth final')).toBe(true);
  });

  it('dedupes by task id, first occurrence wins', () => {
    const feed = roomTaskFeed({
      tasks: [
        { taskId: 'dup', title: 'First', status: 'working' },
        { taskId: 'dup', title: 'Second', status: 'done' },
      ],
    });
    expect(feed.tasks).toHaveLength(1);
    expect(feed.tasks[0].status).toBe('working');
  });
});

describe('roomTaskFeed origin + last event', () => {
  it('carries originMessageId and a parseable lastEventAt, and drops junk values', () => {
    const feed = roomTaskFeed({
      tasks: [
        { taskId: 't1', title: 'A', status: 'working', originMessageId: ' evt_1 ', lastEventAt: '2026-09-05T01:31:51Z' },
        { taskId: 't2', title: 'B', status: 'done', originMessageId: 42, lastEventAt: 'not a date' },
      ],
    });
    expect(feed.tasks[0]).toMatchObject({ id: 't1', originMessageId: 'evt_1', lastEventAt: '2026-09-05T01:31:51Z' });
    expect(feed.tasks[1].originMessageId).toBeUndefined();
    expect(feed.tasks[1].lastEventAt).toBeUndefined();
  });
});
