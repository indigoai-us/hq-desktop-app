import { describe, it, expect } from 'vitest';
import { repeatedAutomatedMessageKey, type Item } from './notificationGroups';

// The day-grouping + cluster-collapse tests that used to live here exercised
// `buildNotificationGroups`, which was deleted with the tray popover's
// notification feed (PL-07). What survives is the key this module contributes
// to the quick-window side pane's conversation grouping: repeated server-shaped
// automated notices share one conversation, human messages never do.

const AGENT_JOIN = '🤖 A new agent (an agent) just joined the company.';

function agentJoin(id: string, overrides: Partial<Item['dm']> = {}): Item {
  return {
    id,
    kind: 'dm',
    actor: 'A new agent',
    summary: AGENT_JOIN,
    ts: 1,
    dm: {
      eventId: id,
      fromPersonUid: `agt_${id}`,
      fromEmail: `${id}@example.com`,
      fromDisplayName: 'A new agent',
      body: AGENT_JOIN,
      createdAt: new Date(1).toISOString(),
      ...overrides,
    },
  };
}

describe('repeatedAutomatedMessageKey', () => {
  it('gives two agent-join notices from different agents the same key', () => {
    const a = repeatedAutomatedMessageKey(agentJoin('one'));
    const b = repeatedAutomatedMessageKey(agentJoin('two'));
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('matches the same notice across modern and legacy history shapes', () => {
    const modern = repeatedAutomatedMessageKey(agentJoin('modern'));
    const legacy = repeatedAutomatedMessageKey(
      agentJoin('legacy', { fromPersonUid: '' }),
    );
    expect(legacy).toBe(modern);
  });

  it('never keys human prose that happens to mention an agent joining', () => {
    const body = 'I heard a new agent joined, so I updated the onboarding checklist.';
    const human: Item = {
      id: 'dm:maya',
      kind: 'dm',
      actor: 'Maya',
      summary: body,
      ts: 1,
      dm: {
        eventId: 'maya',
        fromPersonUid: 'prs_maya',
        fromEmail: 'maya@example.com',
        fromDisplayName: 'Maya',
        body,
        createdAt: new Date(1).toISOString(),
      },
    };
    expect(repeatedAutomatedMessageKey(human)).toBeNull();
  });

  it('returns null for kinds that are not DMs', () => {
    const share: Item = {
      id: 'share:1',
      kind: 'share',
      actor: 'Stefan',
      summary: 'Shared a file',
      ts: 1,
    };
    expect(repeatedAutomatedMessageKey(share)).toBeNull();
  });
});
