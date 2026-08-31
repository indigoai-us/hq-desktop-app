import { describe, it, expect } from 'vitest';
import {
  type MentionCandidate,
  type ThinkingEntry,
  isAgentUid,
  detectAgentMentions,
  startThinking,
  tick,
  clearForAgents,
  labelFor,
} from './agentThinking';

function member(personUid: string, displayName: string): MentionCandidate {
  return { personUid, displayName };
}

function entry(partial: Partial<ThinkingEntry> & { agentUid: string }): ThinkingEntry {
  return {
    agentName: 'Izzy',
    startedAt: 0,
    phase: 'thinking',
    ...partial,
  };
}

describe('isAgentUid', () => {
  it('accepts agt_, agent_, and agent: prefixes', () => {
    expect(isAgentUid('agt_bot')).toBe(true);
    expect(isAgentUid('agent_helper')).toBe(true);
    expect(isAgentUid('agent:worker')).toBe(true);
    expect(isAgentUid('  agt_bot  ')).toBe(true);
  });
  it('rejects human uids and blanks', () => {
    expect(isAgentUid('prs_izzy')).toBe(false);
    expect(isAgentUid('')).toBe(false);
    expect(isAgentUid('agent')).toBe(false);
  });
});

describe('detectAgentMentions', () => {
  const izzy = member('agt_izzy', 'Izzy (Fleet)');
  const izzyAgent = member('agt_izzy2', 'Izzy Agent');
  const human = member('prs_izzy', 'Izzy (Fleet)');
  const lin = member('agt_lin', 'Lin');

  it('matches the full display name', () => {
    expect(detectAgentMentions('hey @Izzy (Fleet) can you /deploy', [izzy])).toEqual([
      izzy,
    ]);
  });

  it('matches the first name token of a parenthetical or multi-word name', () => {
    expect(detectAgentMentions('@Izzy can you /deploy', [izzy])).toEqual([izzy]);
    expect(detectAgentMentions('ping @Izzy please', [izzyAgent])).toEqual([izzyAgent]);
  });

  it('is case-insensitive', () => {
    expect(detectAgentMentions('@IZZY (FLEET) go', [izzy])).toEqual([izzy]);
    expect(detectAgentMentions('@izzy go', [izzy])).toEqual([izzy]);
  });

  it('ignores a non-agent member with the same display name', () => {
    expect(detectAgentMentions('@Izzy hello', [human, izzy])).toEqual([izzy]);
    expect(detectAgentMentions('@Izzy hello', [human])).toEqual([]);
  });

  it('does not match an email (the @ is preceded by a word character)', () => {
    expect(detectAgentMentions('write a@izzy.com please', [izzy])).toEqual([]);
    expect(detectAgentMentions('mail team@lin.dev', [lin])).toEqual([]);
  });

  it('does not match a prefix of a longer token', () => {
    expect(detectAgentMentions('hey @Izzyfoo', [izzy])).toEqual([]);
  });

  it('dedupes by personUid', () => {
    const dup = member('agt_izzy', 'Izzy (Fleet)');
    expect(detectAgentMentions('@Izzy @Izzy (Fleet)', [izzy, dup])).toEqual([izzy]);
  });

  it('returns every distinct mentioned agent, roster order', () => {
    expect(detectAgentMentions('@Izzy and @Lin please', [human, izzy, lin])).toEqual([
      izzy,
      lin,
    ]);
  });
});

describe('startThinking', () => {
  const agent = { agentUid: 'agt_izzy', agentName: 'Izzy (Fleet)' };

  it('appends a thinking row and does not mutate the input', () => {
    const original: ThinkingEntry[] = [];
    const next = startThinking(original, agent, 1000);
    expect(original).toEqual([]);
    expect(next).toEqual([
      {
        agentUid: 'agt_izzy',
        agentName: 'Izzy (Fleet)',
        startedAt: 1000,
        phase: 'thinking',
      },
    ]);
    expect(next).not.toBe(original);
  });

  it('is idempotent per agentUid — a restart resets startedAt and phase', () => {
    const slow = entry({
      agentUid: 'agt_izzy',
      agentName: 'Izzy (Fleet)',
      startedAt: 1,
      phase: 'slow',
    });
    const other = entry({ agentUid: 'agt_lin', agentName: 'Lin', startedAt: 2 });
    const next = startThinking([slow, other], agent, 9_000);
    expect(next).toEqual([
      {
        agentUid: 'agt_izzy',
        agentName: 'Izzy (Fleet)',
        startedAt: 9_000,
        phase: 'thinking',
      },
      other,
    ]);
  });
});

describe('tick', () => {
  it('flips phase to slow at the slowAfterMs threshold', () => {
    const row = entry({ agentUid: 'agt_izzy', startedAt: 0, phase: 'thinking' });
    expect(tick([row], 149_999, { slowAfterMs: 150_000 })[0].phase).toBe('thinking');
    const flipped = tick([row], 150_000, { slowAfterMs: 150_000 });
    expect(flipped[0].phase).toBe('slow');
    expect(flipped[0]).not.toBe(row);
  });

  it('uses the 150s default when opts are omitted', () => {
    const row = entry({ agentUid: 'agt_izzy', startedAt: 0 });
    expect(tick([row], 149_999)[0].phase).toBe('thinking');
    expect(tick([row], 150_000)[0].phase).toBe('slow');
  });

  it('removes entries at expireAfterMs (no-stuck-forever)', () => {
    const row = entry({
      agentUid: 'agt_izzy',
      startedAt: 0,
      phase: 'slow',
    });
    expect(tick([row], 599_999, { expireAfterMs: 600_000 })).toEqual([row]);
    expect(tick([row], 600_000, { expireAfterMs: 600_000 })).toEqual([]);
  });

  it('uses the 600s default expiry', () => {
    const row = entry({ agentUid: 'agt_izzy', startedAt: 0, phase: 'slow' });
    expect(tick([row], 599_999)).toHaveLength(1);
    expect(tick([row], 600_000)).toEqual([]);
  });
});

describe('clearForAgents', () => {
  it('drops matching uids and leaves the rest, without mutating input', () => {
    const izzy = entry({ agentUid: 'agt_izzy' });
    const lin = entry({ agentUid: 'agt_lin', agentName: 'Lin' });
    const original = [izzy, lin];
    const next = clearForAgents(original, ['agt_izzy', 'prs_human']);
    expect(next).toEqual([lin]);
    expect(original).toEqual([izzy, lin]);
  });
});

describe('labelFor', () => {
  it('renders both phases', () => {
    expect(
      labelFor(entry({ agentUid: 'agt_izzy', agentName: 'Izzy', phase: 'thinking' })),
    ).toBe('Izzy is thinking…');
    expect(
      labelFor(entry({ agentUid: 'agt_izzy', agentName: 'Izzy', phase: 'slow' })),
    ).toBe('Izzy is taking longer than usual…');
  });
});
