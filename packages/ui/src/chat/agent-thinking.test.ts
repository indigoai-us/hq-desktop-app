import { describe, it, expect } from 'vitest';
import {
  type MentionCandidate,
  type ThinkingEntry,
  type ThinkingByRow,
  isAgentUid,
  detectAgentMentions,
  startThinking,
  tick,
  clearForAgents,
  clearFromMessages,
  newestMessageAtFrom,
  labelFor,
  startThinkingIn,
  tickAll,
  clearRowFromMessages,
  dropRow,
  kickoffThinkingState,
} from './agent-thinking.js';

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

describe('clearFromMessages', () => {
  const started = 1_000_000_000_000; // arbitrary epoch ms
  it('clears a row when the agent message is newer than startedAt', () => {
    const rows = [entry({ agentUid: 'agt_a', startedAt: started })];
    const out = clearFromMessages(rows, [
      {
        fromPersonUid: 'agt_a',
        createdAt: new Date(started + 5_000).toISOString(),
      },
    ]);
    expect(out).toEqual([]);
  });

  it('keeps a row when the only agent message predates the mention (full re-fetch)', () => {
    const rows = [entry({ agentUid: 'agt_a', startedAt: started })];
    const out = clearFromMessages(rows, [
      {
        fromPersonUid: 'agt_a',
        createdAt: new Date(started - 600_000).toISOString(),
      },
      { fromPersonUid: 'prs_human', createdAt: new Date(started + 1_000).toISOString() },
    ]);
    expect(out).toHaveLength(1);
  });

  it('tolerates modest server/client clock skew (reply slightly before startedAt)', () => {
    const rows = [entry({ agentUid: 'agt_a', startedAt: started })];
    const out = clearFromMessages(rows, [
      {
        fromPersonUid: 'agt_a',
        createdAt: new Date(started - 60_000).toISOString(),
      },
    ]);
    expect(out).toEqual([]);
  });

  it('fails open: a message without a timestamp clears the row', () => {
    const rows = [entry({ agentUid: 'agt_a', startedAt: started })];
    expect(clearFromMessages(rows, [{ fromPersonUid: 'agt_a' }])).toEqual([]);
  });

  it('does not mutate input and ignores unrelated senders', () => {
    const rows = [entry({ agentUid: 'agt_a', startedAt: started })];
    const out = clearFromMessages(rows, [
      { fromPersonUid: 'prs_x', createdAt: new Date(started + 1).toISOString() },
    ]);
    expect(out).toHaveLength(1);
    expect(out).not.toBe(rows);
  });
});

describe('fast responders (local bots): afterMs replaces the skew fallback', () => {
  const BOT = 'agt_bot';
  it('a reply from 30 s ago does not clear a fresh row, but a newer one does', () => {
    const prevReply = '2026-09-11T15:05:53.000Z';
    const sentAt = Date.parse('2026-09-11T15:06:06.000Z');
    const timeline = [
      { fromPersonUid: 'prs_me', createdAt: '2026-09-11T15:05:50.000Z' },
      { fromPersonUid: BOT, createdAt: prevReply },
    ];
    const rows = startThinking([], { agentUid: BOT, agentName: 'claude-bot' }, sentAt, {
      afterMs: newestMessageAtFrom(timeline, BOT),
    });
    expect(rows[0]?.afterMs).toBe(Date.parse(prevReply));
    // Catch-up page that still only carries the OLD reply (inside the 120 s skew window).
    expect(clearFromMessages(rows, timeline)).toHaveLength(1);
    // The actual answer arrives (server clock even slightly behind the client).
    expect(
      clearFromMessages(rows, [{ fromPersonUid: BOT, createdAt: '2026-09-11T15:06:05.000Z' }]),
    ).toHaveLength(0);
  });
  it('falls back to the skew rule when the agent has no prior message', () => {
    const now = 1_000_000_000_000;
    const rows = startThinking([], { agentUid: BOT, agentName: 'b' }, now, {
      afterMs: newestMessageAtFrom([{ fromPersonUid: 'prs_me', createdAt: new Date(now).toISOString() }], BOT),
    });
    expect(rows[0]?.afterMs).toBeUndefined();
    expect(
      clearFromMessages(rows, [{ fromPersonUid: BOT, createdAt: new Date(now - 60_000).toISOString() }]),
    ).toHaveLength(0);
  });
});

describe('per-row map (thinking survives navigation)', () => {
  const izzy = { agentUid: 'agt_izzy', agentName: 'Izzy' };
  const lin = { agentUid: 'agt_lin', agentName: 'Lin' };
  const A = 'ch:chn_a';
  const B = 'dm:agt_izzy';

  it('startThinkingIn scopes the row to its conversation and never mutates', () => {
    const empty: ThinkingByRow = {};
    const one = startThinkingIn(empty, A, izzy, 1000, { afterMs: 500 });
    expect(empty).toEqual({});
    expect(one).toEqual({
      [A]: [{ agentUid: 'agt_izzy', agentName: 'Izzy', startedAt: 1000, phase: 'thinking', afterMs: 500 }],
    });
    const two = startThinkingIn(one, B, izzy, 2000);
    expect(one[B]).toBeUndefined();
    expect(two[A]).toBe(one[A]);
    expect(two[B]?.[0]?.startedAt).toBe(2000);
    // Restart in the same row replaces in place (idempotent per agent).
    const again = startThinkingIn(two, A, izzy, 3000);
    expect(again[A]).toHaveLength(1);
    expect(again[A]?.[0]?.startedAt).toBe(3000);
    expect(again[A]?.[0]?.afterMs).toBeUndefined();
  });

  it('tickAll advances every row and drops rows emptied by expiry', () => {
    let map = startThinkingIn({}, A, izzy, 0);
    map = startThinkingIn(map, B, lin, 500_000);
    const ticked = tickAll(map, 600_000);
    expect(ticked[A], 'expired row removed').toBeUndefined();
    expect(ticked[B]).toEqual([{ ...map[B]![0]!, phase: 'thinking' }]);
    const slow = tickAll(map, 160_000);
    expect(slow[A]?.[0]?.phase).toBe('slow');
    expect(slow[B]?.[0]?.phase).toBe('thinking');
    expect(map[A]?.[0]?.phase, 'input untouched').toBe('thinking');
  });

  it('clearRowFromMessages only touches the named row and honours afterMs', () => {
    const started = 1_000_000_000_000;
    let map = startThinkingIn({}, A, izzy, started, { afterMs: started - 30_000 });
    map = startThinkingIn(map, B, izzy, started);
    const reply = [{ fromPersonUid: 'agt_izzy', createdAt: new Date(started + 5_000).toISOString() }];
    const cleared = clearRowFromMessages(map, A, reply);
    expect(cleared[A], 'row A cleared and dropped').toBeUndefined();
    expect(cleared[B], 'row B untouched by A traffic').toEqual(map[B]);
    expect(map[A], 'input untouched').toHaveLength(1);
    // An OLD reply (<= afterMs) in the same row keeps the status.
    const stale = clearRowFromMessages(map, A, [
      { fromPersonUid: 'agt_izzy', createdAt: new Date(started - 30_000).toISOString() },
    ]);
    expect(stale[A]).toEqual(map[A]);
    expect(stale).not.toBe(map);
    // Unknown row is a no-op copy.
    expect(clearRowFromMessages(map, 'ch:nope', reply)).toEqual(map);
  });

  it('dropRow removes exactly one row', () => {
    let map = startThinkingIn({}, A, izzy, 0);
    map = startThinkingIn(map, B, lin, 0);
    const dropped = dropRow(map, A);
    expect(dropped).toEqual({ [B]: map[B] });
    expect(map[A]).toHaveLength(1);
    expect(dropRow(dropped, 'ch:nope')).toEqual(dropped);
  });
});

describe('kickoffThinkingState', () => {
  const bot = 'agt_setup';
  const intro = { fromPersonUid: bot, createdAt: '2026-09-12T21:40:41.000Z' };
  const reply = { fromPersonUid: bot, createdAt: '2026-09-12T21:42:10.000Z' };
  const mine = { fromPersonUid: 'prs_me', createdAt: '2026-09-12T21:41:00.000Z' };

  it('waits until the intro lands', () => {
    expect(kickoffThinkingState([], bot)).toEqual({ state: 'waiting' });
    expect(kickoffThinkingState([mine], bot)).toEqual({ state: 'waiting' });
  });
  it('starts once only the intro is there, pinned so the intro never clears the row but the answer does', () => {
    const decision = kickoffThinkingState([intro, mine], bot);
    expect(decision).toEqual({ state: 'start', afterMs: Date.parse(intro.createdAt) });
    const rows = startThinking([], { agentUid: bot, agentName: 'setup' }, Date.parse(intro.createdAt) + 500, {
      afterMs: (decision as { afterMs: number }).afterMs,
    });
    expect(clearFromMessages(rows, [intro])).toHaveLength(1);
    expect(clearFromMessages(rows, [intro, reply])).toHaveLength(0);
  });
  it('is done when the answer already landed', () => {
    expect(kickoffThinkingState([intro, reply], bot)).toEqual({ state: 'done' });
  });
});
