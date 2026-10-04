import { describe, expect, it } from 'vitest';

import {
  STATUS_SILENCE_CHECK_GAP_MS,
  STATUS_SILENT_AFTER_MS,
  applyDmAgentStatus,
  endStatusSilent,
  endStatusSilentAll,
  parseDmAgentStatusWake,
  startThinking,
  startThinkingIn,
  statusSilenceClockRestarts,
  stoppedRespondingApplies,
  stoppedRespondingFrom,
  type StoppedResponding,
  type ThinkingByRow,
} from './agent-thinking.js';

/**
 * B-2: "<Name> stopped responding. Try again." showed under a completed
 * answer and while the bot was still working. It now shows only when the
 * person's own message is the newest one in the conversation, and a stretch
 * in which the app could not hear statuses is never read as the bot going
 * quiet.
 */

const NOVA = 'agt_nova';
const ME = 'prs_me';
const t = (s: number) => new Date(Date.UTC(2026, 9, 3, 10, 0, s)).toISOString();
const ms = (s: number) => Date.parse(t(s));
const wake = (s: number, status = 'Working') =>
  parseDmAgentStatusWake({ type: 'agent_status', agentUid: NOVA, withPersonUid: ME, status, ts: t(s) })!;
const fromBot = (s: number, eventId = `bot_${s}`) => ({ eventId, fromPersonUid: NOVA, createdAt: t(s) });
const fromMe = (s: number, eventId = `me_${s}`) => ({ eventId, fromPersonUid: ME, createdAt: t(s) });
const who = { agentUid: NOVA, selfUid: ME };

describe('stoppedRespondingApplies: only when the person\'s message is the newest', () => {
  /** A row that began at second 20 for the person's message `me_20`. */
  const note: StoppedResponding = { name: 'Nova', since: ms(20), askedEventId: 'me_20' };

  it('applies when the person\'s message is the newest one', () => {
    expect(stoppedRespondingApplies(note, [fromBot(5), fromMe(20)], who)).toBe(true);
    // Any order.
    expect(stoppedRespondingApplies(note, [fromMe(20), fromBot(5)], who)).toBe(true);
  });

  it('does not apply when the newest message is the bot\'s', () => {
    expect(stoppedRespondingApplies(note, [fromMe(20), fromBot(60)], who)).toBe(false);
    // Under a completed answer, whatever the row's own times say.
    expect(stoppedRespondingApplies({ name: 'Nova', since: ms(900) }, [fromMe(20), fromBot(60)], who)).toBe(false);
    expect(stoppedRespondingApplies({ name: 'Nova', since: 0 }, [fromMe(20), fromBot(60)], who)).toBe(false);
  });

  it('counts the bot\'s message as the newer one on a tie', () => {
    expect(stoppedRespondingApplies(note, [fromBot(20), fromMe(20)], who)).toBe(false);
    expect(stoppedRespondingApplies(note, [fromMe(20), fromBot(20)], who)).toBe(false);
  });

  it('does not apply when the person\'s newest message is newer than the row\'s start and is not the one the row was for', () => {
    // Written from another device after the row began.
    expect(stoppedRespondingApplies(note, [fromMe(20), fromMe(70, 'me_other')], who)).toBe(false);
    // A row a status started (no send here): a later message of the person's is newer than its start.
    expect(stoppedRespondingApplies({ name: 'Nova', since: ms(30) }, [fromMe(70)], who)).toBe(false);
  });

  it('applies for a row a status started when the person\'s last message is older than the row', () => {
    expect(stoppedRespondingApplies({ name: 'Nova', since: ms(30) }, [fromBot(5), fromMe(20)], who)).toBe(true);
  });

  it('knows the message the row was for by its id, whatever the clocks say', () => {
    // The server's clock is ahead of this Mac's: the sent message reads as
    // newer than the row's local start. It is still the message the row was for.
    const skewed: StoppedResponding = { name: 'Nova', since: ms(20), askedEventId: 'me_sent' };
    expect(stoppedRespondingApplies(skewed, [fromBot(5), fromMe(45, 'me_sent')], who)).toBe(true);
    // Without the id, the same clocks turn the sentence off, never on.
    expect(stoppedRespondingApplies({ name: 'Nova', since: ms(20) }, [fromBot(5), fromMe(45, 'me_sent')], who)).toBe(false);
  });

  it('a clock that disagrees with the server cannot put the sentence under the bot\'s answer', () => {
    for (const since of [ms(0), ms(20), ms(59), ms(60), ms(61), ms(10_000)]) {
      for (const askedEventId of [undefined, 'me_20', 'bot_60']) {
        const n: StoppedResponding = { name: 'Nova', since, ...(askedEventId ? { askedEventId } : {}) };
        expect(stoppedRespondingApplies(n, [fromMe(20), fromBot(60)], who), `${since} ${askedEventId}`).toBe(false);
      }
    }
  });

  it('does not apply when the order cannot be told, or nobody can say whose message is last', () => {
    // No messages (the conversation is not loaded).
    expect(stoppedRespondingApplies(note, [], who)).toBe(false);
    // A bot message with no readable time may be its answer.
    expect(stoppedRespondingApplies(note, [fromMe(20), { eventId: 'b', fromPersonUid: NOVA, createdAt: null }], who)).toBe(false);
    expect(stoppedRespondingApplies(note, [fromMe(20), { eventId: 'b', fromPersonUid: NOVA, createdAt: 'soon' }], who)).toBe(false);
    // The person's own message with no readable time is not counted at all.
    expect(stoppedRespondingApplies(note, [{ eventId: 'me_20', fromPersonUid: ME, createdAt: null }], who)).toBe(false);
    // The signed-in person is not known.
    expect(stoppedRespondingApplies(note, [fromMe(20)], { agentUid: NOVA, selfUid: null })).toBe(false);
    expect(stoppedRespondingApplies(note, [fromMe(20)], { agentUid: NOVA, selfUid: '  ' })).toBe(false);
    // The newest message is someone else's.
    expect(stoppedRespondingApplies(note, [fromMe(20), { eventId: 'x', fromPersonUid: 'prs_other', createdAt: t(40) }], who)).toBe(false);
  });

  it('keeps what it needs from the ended row', () => {
    const rows = startThinking([], { agentUid: NOVA, agentName: 'Nova' }, 1_000, { asked: { eventId: ' me_1 ' } });
    expect(stoppedRespondingFrom(rows[0]!)).toEqual({ name: 'Nova', since: 1_000, askedEventId: 'me_1' });
    const byStatus = applyDmAgentStatus([], wake(30), 'Nova', [], 2_000);
    expect(stoppedRespondingFrom(byStatus[0]!)).toEqual({ name: 'Nova', since: 2_000 });
  });
});

describe('the person writing again is a new ask', () => {
  it('a send remembers the message and forgets the earlier status, so the 90 s wait for the next status', () => {
    // A status (late, or from the work before) put a row up at 1 s.
    let rows = applyDmAgentStatus([], wake(1), 'Nova', [], 1_000);
    expect(rows[0]!.lastStatusAt).toBe(1_000);
    // 85 s later the person writes.
    rows = startThinking(rows, { agentUid: NOVA, agentName: 'Nova' }, 86_000, { asked: { eventId: 'me_86' } });
    expect(rows[0]).toMatchObject({ askedEventId: 'me_86', since: 1_000, startedAt: 86_000 });
    expect('lastStatusAt' in rows[0]!).toBe(false);
    // The row does not end 5 s after the person wrote, nor at any later check.
    expect(endStatusSilent(rows, 91_000)).toBe(rows);
    expect(endStatusSilent(rows, 500_000)).toBe(rows);
    // The bot's next status starts the 90 s again, and keeps the message.
    rows = applyDmAgentStatus(rows, wake(100), 'Nova', [], 100_000);
    expect(rows[0]).toMatchObject({ askedEventId: 'me_86', lastStatusAt: 100_000 });
    expect(endStatusSilent(rows, 189_999)).toBe(rows);
    expect(endStatusSilent(rows, 190_000)).toEqual([]);
  });

  it('a send with no event id clears the message the row was for', () => {
    let rows = startThinking([], { agentUid: NOVA, agentName: 'Nova' }, 1_000, { asked: { eventId: 'me_1' } });
    rows = startThinking(rows, { agentUid: NOVA, agentName: 'Nova' }, 2_000, { asked: { eventId: null } });
    expect('askedEventId' in rows[0]!).toBe(false);
  });

  it('a restart that is not a send (a notice, a follow-up mention) keeps the message and the last status', () => {
    let rows = startThinking([], { agentUid: NOVA, agentName: 'Nova' }, 1_000, { asked: { eventId: 'me_1' } });
    rows = applyDmAgentStatus(rows, wake(5), 'Nova', [], 5_000);
    rows = startThinking(rows, { agentUid: NOVA, agentName: 'Nova' }, 9_000);
    expect(rows[0]).toMatchObject({ askedEventId: 'me_1', lastStatusAt: 5_000, since: 1_000 });
  });

  it('passes through the per-row map', () => {
    const map = startThinkingIn({}, `dm:${NOVA}`, { agentUid: NOVA, agentName: 'Nova' }, 1_000, { afterMs: 5, asked: { eventId: 'me_1' } });
    expect(map[`dm:${NOVA}`]![0]).toMatchObject({ afterMs: 5, askedEventId: 'me_1' });
  });
});

describe('a stretch of not listening is not the bot going quiet', () => {
  it('counts the quiet from the later of the last status and the moment listening resumed', () => {
    const rows = applyDmAgentStatus([], wake(0), 'Nova', [], 1_000);
    // Without a restart: 90 s after the status.
    expect(endStatusSilent(rows, 91_000)).toEqual([]);
    // Listening resumed at 80 s: the bot has the full 90 s from then.
    expect(endStatusSilent(rows, 91_000, STATUS_SILENT_AFTER_MS, 80_000)).toBe(rows);
    expect(endStatusSilent(rows, 169_999, STATUS_SILENT_AFTER_MS, 80_000)).toBe(rows);
    expect(endStatusSilent(rows, 170_000, STATUS_SILENT_AFTER_MS, 80_000)).toEqual([]);
    // A restart from before the last status changes nothing.
    expect(endStatusSilent(rows, 90_999, STATUS_SILENT_AFTER_MS, 500)).toBe(rows);
    expect(endStatusSilent(rows, 91_000, STATUS_SILENT_AFTER_MS, 500)).toEqual([]);
    // A restart time that is not a number is ignored.
    expect(endStatusSilent(rows, 91_000, STATUS_SILENT_AFTER_MS, Number.NaN)).toEqual([]);
  });

  it('applies the restart across the map', () => {
    const map: ThinkingByRow = { [`dm:${NOVA}`]: applyDmAgentStatus([], wake(0), 'Nova', [], 1_000) };
    expect(endStatusSilentAll(map, 91_000, STATUS_SILENT_AFTER_MS, 80_000)).toBe(map);
    expect(endStatusSilentAll(map, 170_000, STATUS_SILENT_AFTER_MS, 80_000)).toEqual({});
  });

  it('a check restarts the clock while the window is hidden and after a stretch with no checks', () => {
    expect(STATUS_SILENCE_CHECK_GAP_MS).toBe(15_000);
    // The checks run every 5 s: an ordinary one applies the rule.
    expect(statusSilenceClockRestarts({ now: 10_000, previousCheckAt: 5_000, hidden: false })).toBe(false);
    expect(statusSilenceClockRestarts({ now: 20_000, previousCheckAt: 5_000, hidden: false })).toBe(false);
    // The first check has nothing to compare with.
    expect(statusSilenceClockRestarts({ now: 10_000, previousCheckAt: null, hidden: false })).toBe(false);
    // The Mac slept, or the webview was suspended: the checks did not run.
    expect(statusSilenceClockRestarts({ now: 20_001, previousCheckAt: 5_000, hidden: false })).toBe(true);
    expect(statusSilenceClockRestarts({ now: 3_600_000, previousCheckAt: 5_000, hidden: false })).toBe(true);
    // Hidden: statuses may not be heard, so nothing ends.
    expect(statusSilenceClockRestarts({ now: 10_000, previousCheckAt: 5_000, hidden: true })).toBe(true);
    expect(statusSilenceClockRestarts({ now: 10_000, previousCheckAt: null, hidden: true })).toBe(true);
  });
});
