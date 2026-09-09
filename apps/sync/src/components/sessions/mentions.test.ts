/**
 * `@`-mention decisions, as pure functions of (draft, caret, catalog, chips).
 */
import { describe, expect, it } from 'vitest';

import {
  addMention,
  applyMention,
  deliveryStatusLine,
  draftHasMention,
  filterMentionCandidates,
  mentionQueryAt,
  mentionSummary,
  pruneMentions,
  removeMention,
  type MentionCandidate,
} from './mentions';

const CATALOG: MentionCandidate[] = [
  { uid: 'prs_alex', displayName: 'Alex Smith', kind: 'human', email: 'alex@example.com' },
  { uid: 'prs_corey', displayName: 'Corey Epstein', kind: 'human', email: 'cepstein@example.com' },
  { uid: 'prs_jo', displayName: 'Jo Park', kind: 'human', email: 'jo@example.com' },
  { uid: 'agt_atlas', displayName: 'Atlas', kind: 'agent' },
  { uid: 'agt_scout', displayName: 'Scout Cortez', kind: 'agent' },
];

describe('mentionQueryAt — a token starting with @ at a word start', () => {
  it('opens on a bare @ at the start of the draft', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('opens after whitespace and reads the typed prefix', () => {
    expect(mentionQueryAt('hi @co', 6)).toEqual({ start: 3, end: 6, query: 'co' });
    expect(mentionQueryAt('line one\n@At', 12)).toEqual({ start: 9, end: 12, query: 'At' });
  });

  it('reads only up to the caret', () => {
    expect(mentionQueryAt('@corey rest', 3)).toEqual({ start: 0, end: 3, query: 'co' });
  });

  it('is not a query mid-word (an email address)', () => {
    expect(mentionQueryAt('a@b', 3)).toBeNull();
    expect(mentionQueryAt('mail me at jo@example.com', 25)).toBeNull();
  });

  it('closes once the caret is past a space', () => {
    expect(mentionQueryAt('hi @co rey', 10)).toBeNull();
    expect(mentionQueryAt('@corey ', 7)).toBeNull();
  });

  it('is null with no @ in the token, an empty draft, or a caret before the @', () => {
    expect(mentionQueryAt('hello', 5)).toBeNull();
    expect(mentionQueryAt('', 0)).toBeNull();
    expect(mentionQueryAt('hi @co', 2)).toBeNull();
  });

  it('clamps a caret outside the draft', () => {
    expect(mentionQueryAt('@co', 99)).toEqual({ start: 0, end: 3, query: 'co' });
    expect(mentionQueryAt('@co', -4)).toBeNull();
  });
});

describe('filterMentionCandidates — best match first', () => {
  it('offers the whole catalog (bounded) for an empty prefix', () => {
    expect(filterMentionCandidates(CATALOG, '').map((c) => c.uid)).toEqual(
      CATALOG.map((c) => c.uid),
    );
    expect(filterMentionCandidates(CATALOG, '', 2)).toHaveLength(2);
  });

  it('ranks name-start over word-start over compact over contains, case-insensitively', () => {
    expect(filterMentionCandidates(CATALOG, 'CO').map((c) => c.displayName)).toEqual([
      'Corey Epstein',
      'Scout Cortez',
    ]);
    expect(filterMentionCandidates(CATALOG, 'ep').map((c) => c.displayName)).toEqual([
      'Corey Epstein',
    ]);
    expect(filterMentionCandidates(CATALOG, 'coreyep').map((c) => c.displayName)).toEqual([
      'Corey Epstein',
    ]);
    expect(filterMentionCandidates(CATALOG, 'tla').map((c) => c.displayName)).toEqual(['Atlas']);
  });

  it('matches a person by the local part of their email, last', () => {
    expect(filterMentionCandidates(CATALOG, 'cep').map((c) => c.uid)).toEqual(['prs_corey']);
  });

  it('returns nothing for a prefix nobody matches', () => {
    expect(filterMentionCandidates(CATALOG, 'zzz')).toEqual([]);
  });
});

describe('applyMention — the token becomes @Display Name with a trailing space', () => {
  it('replaces the typed prefix and lands the caret after the space', () => {
    const out = applyMention('hi @co', { start: 3, end: 6 }, CATALOG[1]!);
    expect(out).toEqual({ draft: 'hi @Corey Epstein ', caret: 18 });
  });

  it('keeps the text after the caret and does not double a space', () => {
    const out = applyMention('@co please', { start: 0, end: 3 }, CATALOG[1]!);
    expect(out.draft).toBe('@Corey Epstein please');
    expect(out.caret).toBe('@Corey Epstein'.length);
  });
});

describe('chips — add, remove, and prune against the draft', () => {
  it('adds once per uid', () => {
    const one = addMention([], CATALOG[1]!);
    expect(one).toEqual([{ uid: 'prs_corey', displayName: 'Corey Epstein' }]);
    expect(addMention(one, CATALOG[1]!)).toEqual(one);
    expect(addMention(one, CATALOG[3]!)).toHaveLength(2);
  });

  it('removes by uid and leaves the rest', () => {
    const two = addMention(addMention([], CATALOG[1]!), CATALOG[3]!);
    expect(removeMention(two, 'prs_corey').map((m) => m.uid)).toEqual(['agt_atlas']);
  });

  it('recognises a mention only as its own word', () => {
    const corey = { uid: 'prs_corey', displayName: 'Corey Epstein' };
    expect(draftHasMention('ping @Corey Epstein now', corey)).toBe(true);
    expect(draftHasMention('@Corey Epstein', corey)).toBe(true);
    expect(draftHasMention('x@Corey Epstein', corey)).toBe(false);
    expect(draftHasMention('@Corey Epsteinson', corey)).toBe(false);
    expect(draftHasMention('@Corey', corey)).toBe(false);
  });

  it('drops a chip whose @Name was deleted from the draft', () => {
    const two = addMention(addMention([], CATALOG[1]!), CATALOG[3]!);
    expect(pruneMentions(two, '@Corey Epstein can you look? @Atlas').map((m) => m.uid)).toEqual([
      'prs_corey',
      'agt_atlas',
    ]);
    expect(pruneMentions(two, 'can you look? @Atlas').map((m) => m.uid)).toEqual(['agt_atlas']);
    expect(pruneMentions(two, '')).toEqual([]);
  });
});

describe('what the footer says', () => {
  it('names who will be DMed', () => {
    expect(mentionSummary([])).toBe('');
    expect(mentionSummary([{ uid: 'a', displayName: 'Corey Epstein' }])).toBe('Will DM Corey Epstein');
    expect(
      mentionSummary([
        { uid: 'a', displayName: 'Corey Epstein' },
        { uid: 'b', displayName: 'Atlas' },
      ]),
    ).toBe('Will DM Corey Epstein and Atlas');
    expect(
      mentionSummary([
        { uid: 'a', displayName: 'A' },
        { uid: 'b', displayName: 'B' },
        { uid: 'c', displayName: 'C' },
      ]),
    ).toBe('Will DM A, B and C');
  });

  it('reports delivery, naming the failures with their reason', () => {
    const mentions = [
      { uid: 'prs_corey', displayName: 'Corey Epstein' },
      { uid: 'agt_atlas', displayName: 'Atlas' },
    ];
    expect(deliveryStatusLine([], mentions)).toBeNull();
    expect(
      deliveryStatusLine(
        [
          { uid: 'prs_corey', ok: true },
          { uid: 'agt_atlas', ok: true },
        ],
        mentions,
      ),
    ).toEqual({ text: "DM'd Corey Epstein and Atlas", error: false });
    expect(
      deliveryStatusLine(
        [
          { uid: 'prs_corey', ok: true },
          { uid: 'agt_atlas', ok: false, error: 'Network error' },
        ],
        mentions,
      ),
    ).toEqual({ text: "Couldn't DM Atlas (Network error)", error: true });
    expect(deliveryStatusLine([{ uid: 'prs_x', ok: false }], mentions)).toEqual({
      text: "Couldn't DM prs_x",
      error: true,
    });
  });
});
