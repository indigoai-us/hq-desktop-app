import { describe, expect, it } from 'vitest';
import { appendInboundBatch, shouldAppendInbound } from './dmThread';

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
