import { beforeEach, describe, expect, it, vi } from 'vitest';

// Any attempt to start a model process (headless CLI, metered API wrapper)
// would go through child_process. Trap every entrypoint so the suite fails
// loudly instead of launching one.
const spawnTrap = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:child_process', () => {
  const trap = () => {
    spawnTrap.calls += 1;
    throw new Error('local-meeting-signals harness must not launch a process');
  };
  return { spawn: trap, spawnSync: trap, exec: trap, execSync: trap, execFile: trap, execFileSync: trap, fork: trap };
});

import {
  audienceReceipt,
  COMPANY_UID,
  localObservations,
  meeting,
  MEMBER_UID,
  memberPrefix,
  negative,
  OTHER_MEMBER_UID,
  roster,
  SIGNAL_TYPES,
  transcript,
} from './local-meeting-signals/fixture';
import { createLocalSignalsHarness, type LocalSignalsHarness } from './local-meeting-signals/harness';

/**
 * signals-local-meetings-v1 US-001 — Phase 0 regression harness.
 *
 * Proves the fixture and harness are complete enough for US-002+ to build on.
 * No network, no credential, no UI route, no model process.
 */

let h: LocalSignalsHarness;
beforeEach(() => {
  spawnTrap.calls = 0;
  h = createLocalSignalsHarness();
});

describe('US-001 fixture: completed bot-captured meeting', () => {
  it('exposes transcript, audience receipt, projection, provider, and output stores', () => {
    expect(meeting).toMatchObject({ capture: 'bot', status: 'completed', visibility: 'company' });
    expect(h.stores.transcript).toEqual(transcript);
    expect(roster.invitees.map((i) => i.personUid)).toEqual([MEMBER_UID, OTHER_MEMBER_UID]);
    expect(h.stores.audience.memberUids).toEqual(roster.invitees.map((i) => i.personUid));
    expect(h.verifyAudienceReceipt(audienceReceipt)).toEqual({ ok: true });
    expect(h.stores.projection.memberUid).toBe(MEMBER_UID);
    expect(h.checkProjectionFresh(h.stores.projection)).toEqual({ ok: true });
    expect(h.providerReadiness().state).toBe('ready');
    expect(h.stores.localFiles.size).toBe(0);
    expect(h.stores.companyFiles.size).toBe(0);
  });

  it('covers all eight signal types with transcript citations', () => {
    expect(new Set(localObservations.map((o) => o.type))).toEqual(new Set(SIGNAL_TYPES));
    h.assert.citations(localObservations);
  });
});

describe('US-001 provider states (no model process)', () => {
  it.each([
    ['claude-ready', 'ready', 'claude'],
    ['codex-ready', 'ready', 'codex'],
    ['no-session', 'pending', null],
  ] as const)('%s → %s', (state, readiness, provider) => {
    h.setProvider(state);
    expect(h.providerReadiness()).toMatchObject({ state: readiness, provider });
    expect(spawnTrap.calls).toBe(0);
    h.assert.noModelProcess();
  });

  it('a no-session request stays pending and starts no fallback', () => {
    h.setProvider('no-session');
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.runState(run.jobId, 'pending');
    h.assert.meetingsState(run.jobId, 'waiting-for-session');
    expect(h.extractorCalls).toBe(0);
    h.assert.noCompanyWrites();
    expect(spawnTrap.calls).toBe(0);
  });
});

describe('US-001 simulated completed run', () => {
  it.each(['claude-ready', 'codex-ready'] as const)('%s: run state, files, citations, lookups, UI state are addressable', (state) => {
    h.setProvider(state);
    h.assert.meetingsState(undefined, 'generate');
    const { run } = h.submitRequest();
    expect(run).toMatchObject({ companyUid: COMPANY_UID, memberUid: MEMBER_UID, sourceRef: meeting.sourceRef });
    expect(run.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    h.runToCompletion(run.jobId);

    h.assert.runState(run.jobId, 'complete');
    expect(run.history.map((x) => x.state)).toEqual(['pending', 'claimed', 'extracting', 'writing', 'uploading', 'complete']);
    const local = JSON.parse(h.assert.localFile(`meetings/${meeting.meetingId}/signals/observations.json`));
    expect(local).toHaveLength(8);
    expect(local.some((o: { privateNote?: string }) => o.privateNote)).toBe(true); // stays on device
    h.assert.localFile(`meetings/${meeting.meetingId}/signals/receipt.json`);
    h.assert.sanitizedCompanyFiles();
    h.assert.citations(local);
    h.assert.entityLookup('Atlas beta', 'ent-project-atlas');
    h.assert.entityLookup('Unknown Corp', null);
    expect(h.stores.entityLookups.length).toBeGreaterThan(2);
    expect(h.stores.contributionReceipts).toEqual([
      expect.objectContaining({
        jobId: run.jobId,
        memberUid: MEMBER_UID,
        companyPath: `${memberPrefix(COMPANY_UID, MEMBER_UID)}${meeting.meetingId}/observations.json`,
        observationIds: localObservations.map((o) => o.id),
      }),
    ]);
    h.assert.meetingsState(run.jobId, 'signals-ready');
    expect(h.extractorCalls).toBe(1);
    expect(spawnTrap.calls).toBe(0);
  });
});

describe('US-001 negative fixtures fail closed or stay idempotent', () => {
  it('private source: kept locally, never contributed', () => {
    const { run } = h.submitRequest(negative.privateSource);
    h.runToCompletion(run.jobId, negative.privateSource);
    h.assert.guardFailed('private-source');
    h.assert.localFile(`meetings/${negative.privateSource.meetingId}/signals/observations.json`);
    h.assert.noCompanyWrites();
  });

  it("another member's prefix is refused, including traversal", () => {
    expect(h.checkPrefix(negative.otherMemberPrefixPath)).toEqual({ ok: false, reason: 'foreign-prefix' });
    expect(h.checkPrefix(`${memberPrefix(COMPANY_UID, MEMBER_UID)}../${OTHER_MEMBER_UID}/x.json`)).toEqual({ ok: false, reason: 'foreign-prefix' });
    h.assert.guardFailed('foreign-prefix');
  });

  it('stale projection fails the run before extraction', () => {
    h.stores.projection = structuredClone(negative.staleProjection);
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.guardFailed('stale-projection');
    h.assert.runState(run.jobId, 'failed');
    h.assert.meetingsState(run.jobId, 'failed');
    expect(h.extractorCalls).toBe(0);
    h.assert.noCompanyWrites();
  });

  it('tampered audience receipt fails the run before extraction', () => {
    expect(h.verifyAudienceReceipt(negative.tamperedReceipt)).toEqual({ ok: false, reason: 'tampered-receipt' });
    h.stores.audience = structuredClone(negative.tamperedReceipt);
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.runState(run.jobId, 'failed');
    expect(h.extractorCalls).toBe(0);
    h.assert.noCompanyWrites();
  });

  it('duplicate request returns the existing job and never re-extracts', () => {
    const first = h.submitRequest();
    h.runToCompletion(first.run.jobId);
    const second = h.submitRequest();
    expect(second.duplicate).toBe(true);
    expect(second.run.jobId).toBe(first.run.jobId);
    h.runToCompletion(second.run.jobId);
    h.assert.guardFailed('duplicate-request');
    expect(h.extractorCalls).toBe(1);
    expect(h.stores.runs.size).toBe(1);
    expect(h.stores.contributionReceipts).toHaveLength(1);
  });
});
