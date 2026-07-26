import { describe, it, expect } from 'vitest';
import {
  isAgentUid,
  participantTypeOf,
  mentionCandidates,
  filterCandidates,
  activeMentionQuery,
  applyMention,
  resolveMentions,
  mentionsAnyAgent,
  agentStateFrom,
  agentStateLabel,
  AGENT_WORKING_STALE_MS,
  type MentionCandidate,
} from './roomMentions';
import type { ChannelMember } from './channels';

const AGENT = 'agt_01AAAAAAAAAAAAAAAAAAAAAAAA';
const AGENT2 = 'agt_01BBBBBBBBBBBBBBBBBBBBBBBB';
const ME = 'prs_01MEMEMEMEMEMEMEMEMEMEMEME';
const COREY = 'prs_01COREYCOREYCOREYCOREYCOR';

function member(personUid: string, displayName: string): ChannelMember {
  return { personUid, displayName, email: '', role: 'member' } as ChannelMember;
}

describe('isAgentUid / participantTypeOf', () => {
  it('recognizes every agent prefix and rejects humans', () => {
    expect(isAgentUid(AGENT)).toBe(true);
    expect(isAgentUid('agent_x')).toBe(true);
    expect(isAgentUid('agent:self')).toBe(true);
    expect(isAgentUid(ME)).toBe(false);
    expect(isAgentUid(null)).toBe(false);
    expect(isAgentUid('  ')).toBe(false);
  });

  it('maps uid to the server mention schema kind', () => {
    expect(participantTypeOf(AGENT)).toBe('agent');
    expect(participantTypeOf(ME)).toBe('human');
  });
});

describe('mentionCandidates', () => {
  const roster = [
    member(ME, 'Jacob'),
    member(COREY, 'Corey'),
    member(AGENT, 'Izzy'),
    member(AGENT2, 'Iris'),
  ];

  it('excludes self and sorts agents first, then alphabetical', () => {
    const out = mentionCandidates(roster, ME);
    expect(out.map((c) => c.displayName)).toEqual(['Iris', 'Izzy', 'Corey']);
    expect(out[0]!.participantType).toBe('agent');
    expect(out.some((c) => c.personUid === ME)).toBe(false);
  });

  it('drops members with no usable display name', () => {
    const out = mentionCandidates([member(AGENT, '   '), member(COREY, 'Corey')], ME);
    expect(out.map((c) => c.personUid)).toEqual([COREY]);
  });

  it('attaches owner provenance to agents only', () => {
    const out = mentionCandidates(roster, ME, { [AGENT]: 'Jacob', [COREY]: 'Nope' });
    expect(out.find((c) => c.personUid === AGENT)!.ownerDisplayName).toBe('Jacob');
    expect(out.find((c) => c.personUid === COREY)!.ownerDisplayName).toBeUndefined();
  });
});

describe('filterCandidates', () => {
  const candidates = mentionCandidates(
    [member(AGENT, 'Izzy'), member(AGENT2, 'Iris Delivery'), member(COREY, 'Corey')],
    ME,
  );

  it('returns everything for an empty query', () => {
    expect(filterCandidates(candidates, '')).toHaveLength(3);
  });

  it('prefers prefix matches over substring matches', () => {
    const out = filterCandidates(candidates, 'i');
    expect(out.map((c) => c.displayName)).toEqual(['Iris Delivery', 'Izzy']);
  });

  it('matches case-insensitively on a substring', () => {
    expect(filterCandidates(candidates, 'DELIV').map((c) => c.displayName)).toEqual([
      'Iris Delivery',
    ]);
  });
});

describe('activeMentionQuery', () => {
  it('detects a token at the caret', () => {
    expect(activeMentionQuery('hey @iz', 7)).toEqual({ query: 'iz', start: 4 });
    expect(activeMentionQuery('@iz', 3)).toEqual({ query: 'iz', start: 0 });
  });

  it('returns null when there is no open token', () => {
    expect(activeMentionQuery('hello', 5)).toBeNull();
    // Whitespace closes the token.
    expect(activeMentionQuery('@Izzy can you', 13)).toBeNull();
    // An "@" glued to a word (an email) is not a mention token.
    expect(activeMentionQuery('mail me@example', 15)).toBeNull();
  });
});

describe('applyMention', () => {
  const izzy: MentionCandidate = {
    personUid: AGENT,
    displayName: 'Izzy',
    participantType: 'agent',
  };

  it('replaces the token and appends a trailing space', () => {
    const out = applyMention('hey @iz', 7, izzy);
    expect(out.text).toBe('hey @Izzy ');
    expect(out.caret).toBe(out.text.length);
  });

  it('preserves text after the caret', () => {
    const out = applyMention('hey @iz please', 7, izzy);
    expect(out.text).toBe('hey @Izzy  please');
  });

  it('is a no-op with no active token', () => {
    expect(applyMention('hello', 5, izzy)).toEqual({ text: 'hello', caret: 5 });
  });
});

describe('resolveMentions', () => {
  const candidates = mentionCandidates(
    [member(AGENT, 'Izzy'), member(AGENT2, 'Iris Delivery'), member(COREY, 'Corey')],
    ME,
  );

  it('resolves an agent mention into the server shape', () => {
    expect(resolveMentions('@Izzy can you check?', candidates)).toEqual([
      { participantUid: AGENT, participantType: 'agent', displayName: 'Izzy' },
    ]);
  });

  it('prefers the longest matching name', () => {
    const out = resolveMentions('@Iris Delivery please', candidates);
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe('Iris Delivery');
  });

  it('is case-insensitive and dedupes repeat mentions', () => {
    const out = resolveMentions('@izzy and again @Izzy', candidates);
    expect(out).toHaveLength(1);
    expect(out[0]!.participantUid).toBe(AGENT);
  });

  it('ignores names that are not mention tokens', () => {
    // Bare name with no "@" is narrative, not an address — must NOT notify.
    expect(resolveMentions('waiting on Izzy', candidates)).toEqual([]);
    // Glued to a longer word.
    expect(resolveMentions('@Izzybot', candidates)).toEqual([]);
  });

  it('resolves several participants at once', () => {
    const out = resolveMentions('@Corey and @Izzy', candidates);
    expect(out.map((m) => m.participantUid).sort()).toEqual([AGENT, COREY].sort());
  });
});

describe('mentionsAnyAgent', () => {
  it('is true only when an agent will be woken', () => {
    expect(
      mentionsAnyAgent([{ participantUid: COREY, participantType: 'human', displayName: 'Corey' }]),
    ).toBe(false);
    expect(
      mentionsAnyAgent([{ participantUid: AGENT, participantType: 'agent', displayName: 'Izzy' }]),
    ).toBe(true);
  });
});

describe('agentStateFrom', () => {
  const now = 1_800_000_000_000;

  it('reports idle with no signals', () => {
    expect(agentStateFrom({}, now)).toBe('idle');
  });

  it('reports seen, then working as signals arrive', () => {
    expect(agentStateFrom({ seenAt: now - 1000 }, now)).toBe('seen');
    expect(agentStateFrom({ seenAt: now - 2000, workingAt: now - 1000 }, now)).toBe('working');
  });

  it('degrades a stale working signal to stalled, never back to idle', () => {
    const stale = now - AGENT_WORKING_STALE_MS - 1;
    expect(agentStateFrom({ workingAt: stale }, now)).toBe('stalled');
  });

  it('reports replied once the answer lands after the work', () => {
    expect(agentStateFrom({ workingAt: now - 5000, repliedAt: now - 1000 }, now)).toBe('replied');
  });

  it('keeps working when a new turn starts after an earlier reply', () => {
    expect(agentStateFrom({ repliedAt: now - 9000, workingAt: now - 1000 }, now)).toBe('working');
  });

  it('labels every state in plain words', () => {
    expect(agentStateLabel('idle')).toBe('idle');
    expect(agentStateLabel('seen')).toBe('picked it up');
    expect(agentStateLabel('working')).toBe('working');
    expect(agentStateLabel('stalled')).toBe('still working');
    expect(agentStateLabel('replied')).toBe('replied');
  });
});
