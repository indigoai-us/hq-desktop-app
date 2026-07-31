import { describe, expect, it } from 'vitest';
import { automatedAgentJoinNoticeKey } from './automatedNotices';

const joinBody = '🤖 Izzy (an agent) just joined Indigo.';

describe('automatedAgentJoinNoticeKey', () => {
  it('accepts only the exact server template from a trusted agent identity', () => {
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: joinBody,
        fromPersonUid: 'agt_izzy',
      }),
    ).toBe('🤖 izzy (an agent) just joined indigo.');
  });

  it('compacts exact legacy history rows when the announced and display names match', () => {
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: joinBody,
        fromDisplayName: 'Izzy',
      }),
    ).toBe('🤖 izzy (an agent) just joined indigo.');
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: joinBody,
        fromDisplayName: 'Someone else',
      }),
    ).toBeNull();
  });

  it('rejects human prose that happens to mention a new agent joining', () => {
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: 'Maya said a new agent joined, so I wrote the onboarding notes.',
        fromPersonUid: 'prs_maya',
      }),
    ).toBeNull();
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: joinBody,
        fromPersonUid: 'prs_maya',
        fromDisplayName: 'Izzy',
      }),
    ).toBeNull();
  });

  it('rejects agent-authored rich messages and near-template copy', () => {
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: joinBody,
        fromPersonUid: 'agt_izzy',
        details: 'This is a human-authored explanation.',
      }),
    ).toBeNull();
    expect(
      automatedAgentJoinNoticeKey({
        kind: 'dm',
        body: 'A new agent just joined Indigo.',
        fromPersonUid: 'agt_izzy',
      }),
    ).toBeNull();
  });
});
