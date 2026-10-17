import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Trap every process entrypoint: a metered or headless model run would have to
// go through child_process.
const spawnTrap = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:child_process', () => {
  const trap = () => {
    spawnTrap.calls += 1;
    throw new Error('local-meeting-signals acceptance must not launch a process');
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
  projection,
  providerFixtures,
  roster,
  rosterDigest,
  SIGNAL_TYPES,
  transcript,
} from './local-meeting-signals/fixture';
import { createLocalSignalsHarness, type LocalSignalsHarness } from './local-meeting-signals/harness';

/**
 * signals-local-meetings-v1 US-001 — acceptance tests, one block per criterion.
 * Each block also proves the harness assertions reject a bad state, so later
 * stories cannot pass against a vacuous check.
 */

const here = dirname(fileURLToPath(import.meta.url));
let h: LocalSignalsHarness;
const fetchSpy = vi.fn(() => {
  throw new Error('local-meeting-signals acceptance must not use the network');
});

beforeEach(() => {
  spawnTrap.calls = 0;
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  h = createLocalSignalsHarness();
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(spawnTrap.calls).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('AC0: fixture is one completed bot-captured meeting with all inputs', () => {
  it('meeting, transcript, frozen roster, projection, provider state, observations, receipts', () => {
    expect(meeting).toMatchObject({ companyUid: COMPANY_UID, capture: 'bot', status: 'completed' });
    expect(Number.isNaN(Date.parse(meeting.endedAt))).toBe(false);
    expect(transcript.length).toBeGreaterThan(0);
    expect(new Set(transcript.map((s) => s.id)).size).toBe(transcript.length);

    // Frozen roster is frozen before the meeting ended and bound into the receipt.
    expect(Date.parse(roster.frozenAt)).toBeLessThan(Date.parse(meeting.endedAt));
    expect(audienceReceipt.rosterDigest).toBe(rosterDigest);
    expect(audienceReceipt.memberUids).toContain(MEMBER_UID);

    expect(projection).toMatchObject({ companyUid: COMPANY_UID, memberUid: MEMBER_UID });
    expect(projection.entities.length).toBeGreaterThan(0);

    expect(Object.keys(providerFixtures).sort()).toEqual(['claude-ready', 'codex-ready', 'no-session']);
    expect(new Set(localObservations.map((o) => o.type))).toEqual(new Set(SIGNAL_TYPES));

    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    expect(h.stores.contributionReceipts).toHaveLength(1);
    const [receipt] = h.stores.contributionReceipts;
    expect(receipt.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.stores.companyFiles.has(receipt.companyPath)).toBe(true);
  });

  it('fixture constants are not mutated by a harness run', () => {
    const before = JSON.stringify({ meeting, transcript, roster, audienceReceipt, projection, localObservations });
    h.stores.transcript.pop();
    h.stores.projection.entities.length = 0;
    expect(JSON.stringify({ meeting, transcript, roster, audienceReceipt, projection, localObservations })).toBe(before);
  });
});

describe('AC1: provider states without a model process', () => {
  it.each(['claude-ready', 'codex-ready'] as const)('%s completes using the scripted extractor only', (state) => {
    h.setProvider(state);
    const { run } = h.submitRequest();
    expect(run.provider).toBe(providerFixtures[state].provider);
    expect(run.providerSessionId).toBe(providerFixtures[state].sessionId);
    h.runToCompletion(run.jobId);
    h.assert.runState(run.jobId, 'complete');
    expect(h.extractorCalls).toBe(1);
  });

  it('no-session stays pending; a later session pickup then completes', () => {
    h.setProvider('no-session');
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.runState(run.jobId, 'pending');
    h.assert.meetingsState(run.jobId, 'waiting-for-session');
    expect(h.extractorCalls).toBe(0);

    h.setProvider('claude-ready');
    h.assert.meetingsState(run.jobId, 'in-progress');
    h.runToCompletion(run.jobId);
    h.assert.runState(run.jobId, 'complete');
    expect(h.extractorCalls).toBe(1);
  });
});

describe('AC2: assertions cover each surface and reject bad state', () => {
  it('pass on a completed run', () => {
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.runState(run.jobId, 'complete');
    const local = JSON.parse(h.assert.localFile(`meetings/${meeting.meetingId}/signals/observations.json`));
    h.assert.sanitizedCompanyFiles();
    h.assert.citations(local);
    h.assert.entityLookup('Atlas beta', 'ent-project-atlas');
    h.assert.meetingsState(run.jobId, 'signals-ready');
  });

  it('runState rejects a wrong state and an unknown job', () => {
    const { run } = h.submitRequest();
    expect(() => h.assert.runState(run.jobId, 'complete')).toThrow();
    expect(() => h.assert.runState('job-missing', 'pending')).toThrow();
  });

  it('localFile rejects a missing file', () => {
    expect(() => h.assert.localFile('meetings/none/signals/observations.json')).toThrow();
  });

  it('sanitizedCompanyFiles rejects an unsanitized body and a foreign path', () => {
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    const [path, body] = [...h.stores.companyFiles][0];
    const leaked = localObservations.find((o) => o.privateNote)!;
    h.stores.companyFiles.set(path, body.replace('[', `[{"privateNote":${JSON.stringify(leaked.privateNote)}},`));
    expect(() => h.assert.sanitizedCompanyFiles()).toThrow();

    h.stores.companyFiles.set(path, body);
    h.stores.companyFiles.set(negative.otherMemberPrefixPath, body);
    expect(() => h.assert.sanitizedCompanyFiles()).toThrow();
  });

  it('sanitizedCompanyFiles rejects an empty company store', () => {
    expect(() => h.assert.sanitizedCompanyFiles()).toThrow();
  });

  it('citations rejects missing and dangling citations', () => {
    const [o] = localObservations;
    expect(() => h.assert.citations([{ ...o, citations: [] }])).toThrow();
    expect(() => h.assert.citations([{ ...o, citations: ['seg-does-not-exist'] }])).toThrow();
  });

  it('entityLookup rejects a wrong id and records each lookup', () => {
    expect(() => h.assert.entityLookup('Atlas beta', 'ent-wrong')).toThrow();
    expect(h.stores.entityLookups.at(-1)).toEqual({ query: 'Atlas beta', result: 'ent-project-atlas' });
  });

  it('meetingsState walks generate → in-progress → signals-ready and rejects a mismatch', () => {
    h.assert.meetingsState(undefined, 'generate');
    const { run } = h.submitRequest();
    h.assert.meetingsState(run.jobId, 'in-progress');
    expect(() => h.assert.meetingsState(run.jobId, 'signals-ready')).toThrow();
    h.runToCompletion(run.jobId);
    h.assert.meetingsState(run.jobId, 'signals-ready');
  });

  it('noCompanyWrites rejects a run that contributed', () => {
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    expect(() => h.assert.noCompanyWrites()).toThrow();
  });
});

describe('AC3: negative fixtures fail closed', () => {
  it('private source: local observations only, no company file or receipt', () => {
    const { run } = h.submitRequest(negative.privateSource);
    h.runToCompletion(run.jobId, negative.privateSource);
    h.assert.guardFailed('private-source');
    h.assert.localFile(`meetings/${negative.privateSource.meetingId}/signals/observations.json`);
    h.assert.noCompanyWrites();
  });

  it("another member's prefix is refused, as is a sibling-prefix lookalike", () => {
    expect(h.checkPrefix(negative.otherMemberPrefixPath).ok).toBe(false);
    const own = memberPrefix(COMPANY_UID, MEMBER_UID);
    expect(h.checkPrefix(`${own.replace(/\/$/, '')}-evil/x.json`).ok).toBe(false);
    expect(h.checkPrefix(`${own}${meeting.meetingId}/observations.json`).ok).toBe(true);
  });

  it('stale projection: run fails before extraction', () => {
    h.stores.projection = structuredClone(negative.staleProjection);
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.guardFailed('stale-projection');
    h.assert.runState(run.jobId, 'failed');
    expect(h.extractorCalls).toBe(0);
    expect(h.stores.localFiles.size).toBe(0);
    h.assert.noCompanyWrites();
  });

  it('tampered audience receipt: run fails before extraction', () => {
    h.stores.audience = structuredClone(negative.tamperedReceipt);
    const { run } = h.submitRequest();
    h.runToCompletion(run.jobId);
    h.assert.guardFailed('tampered-receipt');
    h.assert.runState(run.jobId, 'failed');
    h.assert.meetingsState(run.jobId, 'failed');
    expect(h.extractorCalls).toBe(0);
    h.assert.noCompanyWrites();
  });

  it('duplicate request while pending and after completion returns one job', () => {
    const first = h.submitRequest();
    const pendingDup = h.submitRequest();
    expect(pendingDup).toMatchObject({ duplicate: true, run: { jobId: first.run.jobId } });
    h.runToCompletion(first.run.jobId);
    const doneDup = h.submitRequest();
    expect(doneDup.run.jobId).toBe(first.run.jobId);
    h.runToCompletion(doneDup.run.jobId);
    h.assert.guardFailed('duplicate-request');
    expect(h.extractorCalls).toBe(1);
    expect(h.stores.runs.size).toBe(1);
    expect(h.stores.contributionReceipts).toHaveLength(1);
  });
});

describe('AC4: runs through the existing desktop-alt entrypoint without a screen or credential', () => {
  it('the existing desktop-alt config and package script pick up these specs', () => {
    const config = readFileSync(join(here, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'e2e/desktop-alt/**/*.spec.ts'");
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['test:e2e:desktop-alt']).toBe('vitest run --config e2e/desktop-alt/vitest.config.ts');
  });

  it('harness sources import no UI, network, credential, or Tauri module', () => {
    for (const file of ['harness.ts', 'fixture.ts']) {
      const src = readFileSync(join(here, 'local-meeting-signals', file), 'utf8');
      expect(src, file).not.toMatch(/\.svelte['"]|@tauri-apps|from ['"](node:)?(https?|net)['"]|process\.env|keychain|cognito/i);
    }
  });
});
