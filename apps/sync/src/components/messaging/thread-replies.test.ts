import { describe, expect, it } from 'vitest';
import {
  applyInboundReplies,
  effectiveReplyCount,
  foldReplies,
  partitionThreadReplies,
  type FoldableMessage,
} from './thread-replies';

const msg = (
  eventId: string,
  overrides: Partial<FoldableMessage> = {},
): FoldableMessage => ({
  eventId,
  createdAt: '2026-06-05T00:00:00Z',
  ...overrides,
});

describe('effectiveReplyCount', () => {
  it('treats a 0 from the server as missing when replies are present', () => {
    // Regression: `view.replyCount ?? ordered.length` never fired because 0 is
    // not nullish, so the ThreadPanel header showed "0 replies".
    expect(effectiveReplyCount(0, undefined, 2)).toBe(2);
    expect(effectiveReplyCount(0, 0, 1)).toBe(1);
  });

  it('prefers a larger server or root count over the loaded reply list', () => {
    expect(effectiveReplyCount(3, 1, 1)).toBe(3);
    expect(effectiveReplyCount(undefined, 4, 1)).toBe(4);
  });

  it('returns 0 when nothing is known', () => {
    expect(effectiveReplyCount(undefined, null, 0)).toBe(0);
    expect(effectiveReplyCount(0, 0, 0)).toBe(0);
  });
});

describe('partitionThreadReplies', () => {
  it('splits events that carry a parent rootEventId out of the top-level list', () => {
    const events = [
      { eventId: 'root', body: 'hi' },
      { eventId: 'r1', rootEventId: 'root', body: 'reply' },
      { eventId: 'root2', rootEventId: 'root2', body: 'self-root' },
    ];
    const { topLevel, replies } = partitionThreadReplies(events);
    expect(topLevel.map((event) => event.eventId)).toEqual(['root', 'root2']);
    expect(replies.map((event) => event.eventId)).toEqual(['r1']);
  });

  it('treats a missing or blank rootEventId as top-level', () => {
    const { topLevel, replies } = partitionThreadReplies([
      { eventId: 'a' },
      { eventId: 'b', rootEventId: null },
      { eventId: 'c', rootEventId: '  ' },
    ]);
    expect(topLevel.map((event) => event.eventId)).toEqual(['a', 'b', 'c']);
    expect(replies).toEqual([]);
  });
});

describe('foldReplies', () => {
  it('removes reply rows and folds count + lastReplyAt onto the root', () => {
    const folded = foldReplies([
      msg('root'),
      msg('r1', { rootEventId: 'root', createdAt: '2026-06-05T00:01:00Z' }),
      msg('r2', { rootEventId: 'root', createdAt: '2026-06-05T00:03:00Z' }),
      msg('other'),
    ]);
    expect(folded.map((row) => row.eventId)).toEqual(['root', 'other']);
    expect(folded[0].rootEventId).toBe('root');
    expect(folded[0].replyCount).toBe(2);
    expect(folded[0].lastReplyAt).toBe('2026-06-05T00:03:00Z');
    expect(folded[1].replyCount).toBeUndefined();
  });

  it('keeps a larger server replyCount when only some replies are loaded', () => {
    const folded = foldReplies([
      msg('root', { replyCount: 5, createdAt: '2026-06-05T00:00:00Z' }),
      msg('r1', { rootEventId: 'root', createdAt: '2026-06-05T00:01:00Z' }),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0].replyCount).toBe(5);
    expect(folded[0].lastReplyAt).toBe('2026-06-05T00:01:00Z');
    expect(folded[0].rootEventId).toBe('root');
  });

  it('sets rootEventId on a root that only has replyCount so the affordance can render', () => {
    const folded = foldReplies([msg('root', { replyCount: 2 })]);
    expect(folded[0].rootEventId).toBe('root');
    expect(folded[0].replyCount).toBe(2);
  });
});

describe('applyInboundReplies', () => {
  it('increments the matching root once per reply eventId', () => {
    const counted = new Set<string>();
    const root = msg('root');
    const reply = {
      eventId: 'r1',
      rootEventId: 'root',
      createdAt: '2026-06-05T00:02:00Z',
    };
    const once = applyInboundReplies([root], [reply], counted);
    expect(once[0].replyCount).toBe(1);
    expect(once[0].rootEventId).toBe('root');
    expect(once[0].lastReplyAt).toBe('2026-06-05T00:02:00Z');
    const twice = applyInboundReplies(once, [reply, reply], counted);
    expect(twice[0].replyCount).toBe(1);
    expect(twice).toBe(once);
    expect(counted.has('r1')).toBe(true);
  });

  it('ignores replies whose root is not in the main list', () => {
    const counted = new Set<string>();
    const messages = [msg('other')];
    const next = applyInboundReplies(
      messages,
      [{ eventId: 'r1', rootEventId: 'missing', createdAt: '2026-06-05T00:02:00Z' }],
      counted,
    );
    expect(next).toBe(messages);
    expect(counted.size).toBe(0);
  });
});
