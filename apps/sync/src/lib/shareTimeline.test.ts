import { describe, it, expect } from 'vitest';
import type { ShareEvent } from './notificationGroups';
import {
  applySharePreviews,
  buildSharePrompt,
  mergeSharesIntoThread,
  previewRepresentsShare,
  shareMatchesPeer,
  shareSummary,
  sharesForPeer,
} from './shareTimeline';

function share(over: Partial<ShareEvent> = {}): ShareEvent {
  return {
    eventId: 'shr_1',
    issuerEmail: 'ada@getindigo.ai',
    issuerDisplayName: 'Ada Lovelace',
    issuerPersonUid: 'prs_ada',
    paths: ['indigo/reports/q1.md'],
    note: null,
    permission: 'read',
    createdAt: '2026-07-01T10:00:00Z',
    ...over,
  };
}

describe('shareMatchesPeer', () => {
  it('matches by canonical personUid when both sides carry one', () => {
    expect(shareMatchesPeer(share(), { personUid: 'prs_ada', email: 'x@y.z' })).toBe(true);
    expect(shareMatchesPeer(share(), { personUid: 'prs_other', email: 'ada@getindigo.ai' })).toBe(
      false, // uid wins — a mismatched uid is NOT rescued by the email
    );
  });

  it('falls back to case-insensitive email for legacy rows (empty issuerPersonUid)', () => {
    const legacy = share({ issuerPersonUid: '' });
    expect(shareMatchesPeer(legacy, { personUid: 'prs_x', email: 'ADA@getindigo.ai' })).toBe(true);
    expect(shareMatchesPeer(legacy, { personUid: 'prs_x', email: 'bob@getindigo.ai' })).toBe(false);
  });

  it('tolerates an undefined issuerPersonUid (older cached payloads)', () => {
    const legacy = share({ issuerPersonUid: undefined });
    expect(shareMatchesPeer(legacy, { email: 'ada@getindigo.ai' })).toBe(true);
  });

  it('never matches on empty identities', () => {
    expect(shareMatchesPeer(share({ issuerPersonUid: '', issuerEmail: '' }), { email: '' })).toBe(
      false,
    );
  });
});

describe('sharesForPeer', () => {
  it('filters to the peer and sorts oldest → newest', () => {
    const list = [
      share({ eventId: 'b', createdAt: '2026-07-02T00:00:00Z' }),
      share({ eventId: 'x', issuerPersonUid: 'prs_other', issuerEmail: 'o@x.y' }),
      share({ eventId: 'a', createdAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(sharesForPeer(list, { personUid: 'prs_ada' }).map((s) => s.eventId)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('shareSummary / buildSharePrompt', () => {
  it('summarizes single and multi-file shares by basename', () => {
    expect(shareSummary(share())).toBe('Shared a file: q1.md');
    expect(
      shareSummary(share({ paths: ['co/a.md', 'co/b.md'] })),
    ).toBe('Shared 2 files: a.md, b.md');
  });

  it('builds the identical templated prompt ShareDetail uses', () => {
    expect(buildSharePrompt(share({ note: 'look!' }))).toBe(
      'Ada Lovelace shared these files with me: indigo/reports/q1.md\n\nTheir note: look!.',
    );
    expect(buildSharePrompt(share())).toContain('Their note: (no note).');
  });
});

describe('mergeSharesIntoThread', () => {
  const toMsg = (s: ShareEvent) => ({ createdAt: s.createdAt, id: s.eventId });

  it('interleaves shares chronologically among messages', () => {
    const messages = [
      { createdAt: '2026-07-01T09:00:00Z', id: 'm1' },
      { createdAt: '2026-07-01T11:00:00Z', id: 'm2' },
    ];
    const merged = mergeSharesIntoThread(
      messages,
      [share({ eventId: 's1', createdAt: '2026-07-01T10:00:00Z' })],
      toMsg,
    );
    expect(merged.map((m) => m.id)).toEqual(['m1', 's1', 'm2']);
  });

  it('is stable — a same-instant share sorts after the DM', () => {
    const messages = [{ createdAt: '2026-07-01T10:00:00Z', id: 'm1' }];
    const merged = mergeSharesIntoThread(
      messages,
      [share({ eventId: 's1', createdAt: '2026-07-01T10:00:00Z' })],
      toMsg,
    );
    expect(merged.map((m) => m.id)).toEqual(['m1', 's1']);
  });

  it('returns the input list untouched when there are no shares', () => {
    const messages = [{ createdAt: '2026-07-01T09:00:00Z', id: 'm1' }];
    expect(mergeSharesIntoThread(messages, [], toMsg)).toBe(messages);
  });
});

describe('applySharePreviews', () => {
  it('overlays a "Shared a file" preview when the newest item is a share', () => {
    const contacts = [
      {
        personUid: 'prs_ada',
        email: 'ada@getindigo.ai',
        previewBody: 'hello',
        previewAt: '2026-06-30T00:00:00Z',
        previewDirection: 'in',
        lastMessageAt: '2026-06-30T00:00:00Z',
      },
    ];
    const next = applySharePreviews(contacts, [share()]);
    expect(next[0].previewBody).toBe('Shared a file: q1.md');
    expect(next[0].previewDirection).toBe('in');
    expect(next[0].previewAt).toBe('2026-07-01T10:00:00Z');
    // Input untouched.
    expect(contacts[0].previewBody).toBe('hello');
  });

  it('keeps the DM preview when it is newer than the share', () => {
    const contacts = [
      {
        personUid: 'prs_ada',
        email: 'ada@getindigo.ai',
        previewBody: 'newer dm',
        previewAt: '2026-07-02T00:00:00Z',
        lastMessageAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySharePreviews(contacts, [share()]);
    expect(next[0].previewBody).toBe('newer dm');
  });

  it('passes non-matching contacts through unchanged', () => {
    const contacts = [{ personUid: 'prs_bob', email: 'bob@x.y' }];
    expect(applySharePreviews(contacts, [share()])[0]).toBe(contacts[0]);
  });

  it('identifies an exact share-backed preview without hiding a newer DM', () => {
    const event = share();
    const [projected] = applySharePreviews(
      [
        {
          personUid: 'prs_ada',
          previewBody: 'older DM',
          previewAt: '2026-06-30T00:00:00Z',
        },
      ],
      [event],
    );
    expect(previewRepresentsShare(projected, event)).toBe(true);
    expect(
      previewRepresentsShare(
        {
          ...projected,
          previewBody: 'newer DM',
          previewAt: '2026-07-02T00:00:00Z',
        },
        event,
      ),
    ).toBe(false);
  });
});
