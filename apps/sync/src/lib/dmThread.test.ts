import { describe, expect, it } from 'vitest';
import {
  appendInboundBatch,
  mergeHydratedThread,
  shouldAppendInbound,
  type MergeableThreadMessage,
} from './dmThread';

const peer = 'prs_alice';
const msg = (eventId: string) => ({ eventId });
const dm = (eventId: string, fromPersonUid: string) => ({ eventId, fromPersonUid });

describe('shouldAppendInbound (DM detail live thread)', () => {
  it('appends a new DM from the viewed peer', () => {
    expect(shouldAppendInbound([msg('e1')], dm('e2', peer), peer)).toBe(true);
  });

  it('ignores a DM from a different peer (window is one conversation)', () => {
    expect(shouldAppendInbound([], dm('e2', 'prs_bob'), peer)).toBe(false);
  });

  it('ignores a duplicate already in the thread (poll re-surface / thread overlap)', () => {
    expect(shouldAppendInbound([msg('e1'), msg('e2')], dm('e2', peer), peer)).toBe(false);
  });

  it('ignores everything when no peer is set yet (nothing open)', () => {
    expect(shouldAppendInbound([], dm('e2', peer), null)).toBe(false);
    expect(shouldAppendInbound([], dm('e2', peer), undefined)).toBe(false);
    expect(shouldAppendInbound([], dm('e2', peer), '')).toBe(false);
  });

  it('appends into an empty thread from the viewed peer', () => {
    expect(shouldAppendInbound([], dm('first', peer), peer)).toBe(true);
  });
});

describe('appendInboundBatch', () => {
  it('appends only new DMs from the viewed peer, preserving arrival order', () => {
    const out = appendInboundBatch(
      [msg('e1')],
      [dm('e2', peer), dm('skip-other', 'prs_bob'), dm('e2', peer), dm('e3', peer)],
      peer,
      (item) => msg(item.eventId),
    );

    expect(out.map((m) => m.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('returns the same array when nothing is appended', () => {
    const existing = [msg('e1')];
    const out = appendInboundBatch(existing, [dm('e1', peer)], peer, (item) =>
      msg(item.eventId),
    );

    expect(out).toBe(existing);
  });
});

describe('mergeHydratedThread', () => {
  const message = (
    eventId: string,
    createdAt: string,
    body: string,
    direction: 'in' | 'out' = 'in',
  ) => ({
    eventId,
    createdAt,
    body,
    direction,
    fromPersonUid: direction === 'in' ? peer : 'me',
  });

  it('preserves live and optimistic entries while restoring chronological order', () => {
    const hydrated = [
      message('history', '2026-07-28T12:00:00.000Z', 'History'),
      message('opening', '2026-07-28T12:01:00.000Z', 'Opening'),
    ];
    const current = [
      message('local-1', '2026-07-28T12:03:00.000Z', 'Optimistic', 'out'),
      message('live', '2026-07-28T12:02:00.000Z', 'Live'),
    ];

    expect(mergeHydratedThread(hydrated, current).map((item) => item.eventId)).toEqual([
      'history',
      'opening',
      'live',
      'local-1',
    ]);
  });

  it('deduplicates a live/server overlap by stable event id and keeps hydrated data', () => {
    const live = {
      ...message('same-event', '2026-07-28T12:02:00.000Z', 'Live copy'),
      details: null as string | null,
    };
    const hydrated = {
      ...message('same-event', '2026-07-28T12:02:00.000Z', 'Canonical copy'),
      details: 'Server metadata' as string | null,
    };

    expect(mergeHydratedThread([hydrated], [live])).toEqual([hydrated]);
  });

  it('uses a conservative full-message fallback when an event id is absent', () => {
    const idless = {
      ...message('', '2026-07-28T12:02:00.000Z', 'Idless'),
      details: 'same metadata',
    };
    const laterRepeat = {
      ...idless,
      createdAt: '2026-07-28T12:03:00.000Z',
    };

    expect(mergeHydratedThread([idless], [idless, laterRepeat])).toEqual([
      idless,
      laterRepeat,
    ]);
  });

  it('keeps an incomplete idless legacy row without disturbing dated chronology', () => {
    const incomplete: MergeableThreadMessage = { eventId: '' };
    const dated: MergeableThreadMessage = {
      eventId: 'dated',
      createdAt: '2026-07-28T12:00:00.000Z',
    };

    expect(mergeHydratedThread([incomplete], [dated])).toEqual([
      dated,
      incomplete,
    ]);
  });
});
