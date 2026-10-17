import { expect } from 'vitest';
import {
  audienceDigest as fixtureAudienceDigest,
  audienceReceipt as fixtureReceipt,
  canonicalJson,
  COMPANY_UID,
  localObservations,
  meeting as fixtureMeeting,
  MEMBER_UID,
  memberPrefix,
  projection as fixtureProjection,
  PROMPT_VERSION,
  providerFixtures,
  SCHEMA_VERSION,
  sha256,
  signReceipt,
  sourceDigest as fixtureSourceDigest,
  transcript as fixtureTranscript,
  type AudienceReceipt,
  type CompletedMeeting,
  type ContributionReceipt,
  type LocalObservation,
  type MemberProjection,
  type ProviderState,
  type TranscriptSegment,
} from './fixture';

/**
 * signals-local-meetings-v1 US-001 — deterministic in-memory harness.
 *
 * Models the local meeting signal flow end to end with scripted stores so later
 * stories can drive their real code against it. Provider readiness is pure
 * data: the harness has no code path that spawns a process or calls a model,
 * and `processLaunches` stays at zero to prove it.
 */

export type RunState =
  | 'pending'
  | 'claimed'
  | 'extracting'
  | 'writing'
  | 'uploading'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type MeetingsUiState = 'generate' | 'waiting-for-session' | 'in-progress' | 'signals-ready' | 'failed';

export interface RunRecord {
  jobId: string;
  companyUid: string;
  memberUid: string;
  sourceRef: string;
  sourceDigest: string;
  audienceDigest: string;
  provider: 'claude' | 'codex' | null;
  providerSessionId: string | null;
  promptVersion: string;
  schemaVersion: string;
  state: RunState;
  history: { state: RunState; at: string }[];
  status: string;
}

export type GuardOutcome = { ok: true } | { ok: false; reason: GuardFailure };
export type GuardFailure =
  | 'private-source'
  | 'foreign-prefix'
  | 'stale-projection'
  | 'tampered-receipt'
  | 'duplicate-request';

export interface HarnessOptions {
  provider?: ProviderState;
  now?: () => string;
}

const STATUS_TEXT: Record<RunState, string> = {
  pending: 'Waiting for a Claude or Codex session.',
  claimed: 'Session claimed the request.',
  extracting: 'Reading the transcript.',
  writing: 'Saving signals on this device.',
  uploading: 'Sharing sanitized signals with your company.',
  complete: 'Signals ready.',
  cancelled: 'Cancelled.',
  failed: 'Signal generation failed.',
};

const SANITIZE_FORBIDDEN_KEYS = ['privateNote'] as const;

export function createLocalSignalsHarness(options: HarnessOptions = {}) {
  let clock = Date.parse('2026-10-12T18:00:00.000Z');
  const now = options.now ?? (() => new Date((clock += 1000)).toISOString());
  let providerState: ProviderState = options.provider ?? 'claude-ready';

  const stores = {
    meeting: structuredClone(fixtureMeeting) as CompletedMeeting,
    transcript: structuredClone(fixtureTranscript) as TranscriptSegment[],
    audience: structuredClone(fixtureReceipt) as AudienceReceipt,
    projection: structuredClone(fixtureProjection) as MemberProjection,
    localFiles: new Map<string, string>(),
    companyFiles: new Map<string, string>(),
    contributionReceipts: [] as ContributionReceipt[],
    runs: new Map<string, RunRecord>(),
    entityLookups: [] as { query: string; result: string | null }[],
  };
  const guardLog: { guard: string; outcome: GuardOutcome }[] = [];
  let processLaunches = 0;
  let extractorCalls = 0;

  function record(guard: string, outcome: GuardOutcome): GuardOutcome {
    guardLog.push({ guard, outcome });
    return outcome;
  }

  // ── Provider ───────────────────────────────────────────────────────────────
  function setProvider(state: ProviderState) {
    providerState = state;
  }
  function providerReadiness() {
    const f = providerFixtures[providerState];
    return { state: providerState === 'no-session' ? ('pending' as const) : ('ready' as const), ...f };
  }

  // ── Guards ─────────────────────────────────────────────────────────────────
  function verifyAudienceReceipt(receipt: AudienceReceipt): GuardOutcome {
    const { signature, ...unsigned } = receipt;
    return record('audience-receipt', signature === signReceipt(unsigned) ? { ok: true } : { ok: false, reason: 'tampered-receipt' });
  }
  function checkSourceContributable(m: CompletedMeeting): GuardOutcome {
    return record('private-source', m.visibility === 'private' ? { ok: false, reason: 'private-source' } : { ok: true });
  }
  function checkPrefix(path: string, memberUid = MEMBER_UID): GuardOutcome {
    const own = memberPrefix(COMPANY_UID, memberUid);
    const normalized = path.split('/').filter((p) => p !== '.' && p !== '..').join('/');
    const ok = path === normalized && path.startsWith(own);
    return record('member-prefix', ok ? { ok: true } : { ok: false, reason: 'foreign-prefix' });
  }
  function checkProjectionFresh(p: MemberProjection, receipt: AudienceReceipt = stores.audience): GuardOutcome {
    const fresh = p.audienceDigest === sha256(canonicalJson(receipt)) && p.memberUid === MEMBER_UID;
    return record('projection-freshness', fresh ? { ok: true } : { ok: false, reason: 'stale-projection' });
  }

  // ── Entity lookup ──────────────────────────────────────────────────────────
  function lookupEntity(query: string): string | null {
    const q = query.toLowerCase();
    const hit = stores.projection.entities.find(
      (e) => e.name.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q),
    );
    const result = hit?.id ?? null;
    stores.entityLookups.push({ query, result });
    return result;
  }

  // ── Runs ───────────────────────────────────────────────────────────────────
  function transition(run: RunRecord, state: RunState) {
    run.state = state;
    run.status = STATUS_TEXT[state];
    run.history.push({ state, at: now() });
  }

  function requestKey(m: CompletedMeeting) {
    return sha256(canonicalJson({ c: COMPANY_UID, m: MEMBER_UID, s: m.sourceRef, d: fixtureSourceDigest, p: PROMPT_VERSION, v: SCHEMA_VERSION }));
  }

  /** Creates a request, or returns the existing job for an identical source + version tuple. */
  function submitRequest(m: CompletedMeeting = stores.meeting): { run: RunRecord; duplicate: boolean } {
    const jobId = `job-${requestKey(m).slice(0, 16)}`;
    const existing = stores.runs.get(jobId);
    if (existing) {
      record('duplicate-request', { ok: false, reason: 'duplicate-request' });
      return { run: existing, duplicate: true };
    }
    const p = providerReadiness();
    const run: RunRecord = {
      jobId,
      companyUid: COMPANY_UID,
      memberUid: MEMBER_UID,
      sourceRef: m.sourceRef,
      sourceDigest: fixtureSourceDigest,
      audienceDigest: fixtureAudienceDigest,
      provider: p.provider,
      providerSessionId: p.sessionId,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      state: 'pending',
      history: [],
      status: '',
    };
    transition(run, 'pending');
    stores.runs.set(jobId, run);
    return { run, duplicate: false };
  }

  /** Scripted extractor: returns the fixture observations. Never launches a process. */
  function scriptedExtract(): LocalObservation[] {
    extractorCalls += 1;
    return structuredClone(localObservations);
  }

  function sanitize(obs: LocalObservation[]) {
    return obs.map((o) => {
      const copy: Record<string, unknown> = { ...o };
      for (const k of SANITIZE_FORBIDDEN_KEYS) delete copy[k];
      return copy;
    });
  }

  /** Advances a pending run to a terminal state against the scripted provider. */
  function runToCompletion(jobId: string, m: CompletedMeeting = stores.meeting): RunRecord {
    const run = stores.runs.get(jobId);
    if (!run) throw new Error(`unknown job ${jobId}`);
    if (run.state === 'complete') return run;
    if (providerReadiness().state !== 'ready') return run; // stays pending, no fallback
    if (!verifyAudienceReceipt(stores.audience).ok || !checkProjectionFresh(stores.projection).ok) {
      transition(run, 'failed');
      return run;
    }
    transition(run, 'claimed');
    transition(run, 'extracting');
    const observations = scriptedExtract();
    for (const o of observations) for (const ref of o.entityRefs) {
      const ent = stores.projection.entities.find((e) => e.id === ref);
      if (ent) lookupEntity(ent.name);
    }
    transition(run, 'writing');
    const localDir = `meetings/${m.meetingId}/signals/`;
    stores.localFiles.set(`${localDir}observations.json`, JSON.stringify(observations, null, 2));
    stores.localFiles.set(`${localDir}receipt.json`, JSON.stringify({ jobId, count: observations.length }));
    if (checkSourceContributable(m).ok) {
      transition(run, 'uploading');
      const companyPath = `${memberPrefix(COMPANY_UID, MEMBER_UID)}${m.meetingId}/observations.json`;
      if (checkPrefix(companyPath).ok) {
        const body = JSON.stringify(sanitize(observations), null, 2);
        stores.companyFiles.set(companyPath, body);
        stores.contributionReceipts.push({
          jobId,
          memberUid: MEMBER_UID,
          companyPath,
          observationIds: observations.map((o) => o.id),
          contentDigest: sha256(body),
        });
      }
    }
    transition(run, 'complete');
    return run;
  }

  function meetingsUiState(jobId?: string): MeetingsUiState {
    const run = jobId ? stores.runs.get(jobId) : undefined;
    if (!run) return 'generate';
    switch (run.state) {
      case 'pending':
        return providerReadiness().state === 'ready' ? 'in-progress' : 'waiting-for-session';
      case 'complete':
        return 'signals-ready';
      case 'failed':
        return 'failed';
      case 'cancelled':
        return 'generate';
      default:
        return 'in-progress';
    }
  }

  // ── Assertions ─────────────────────────────────────────────────────────────
  const assert = {
    runState(jobId: string, expected: RunState) {
      const run = stores.runs.get(jobId);
      expect(run, `run ${jobId}`).toBeDefined();
      expect(run!.state).toBe(expected);
      expect(run!.status.length).toBeGreaterThan(0);
      expect(run!.status.length).toBeLessThanOrEqual(120);
      for (const h of run!.history) expect(Number.isNaN(Date.parse(h.at))).toBe(false);
    },
    localFile(path: string) {
      expect(stores.localFiles.has(path), `local file ${path}`).toBe(true);
      return stores.localFiles.get(path)!;
    },
    sanitizedCompanyFiles() {
      expect(stores.companyFiles.size).toBeGreaterThan(0);
      for (const [path, body] of stores.companyFiles) {
        expect(path.startsWith(memberPrefix(COMPANY_UID, MEMBER_UID)), path).toBe(true);
        for (const k of SANITIZE_FORBIDDEN_KEYS) expect(body).not.toContain(`"${k}"`);
        for (const o of localObservations) if (o.privateNote) expect(body).not.toContain(o.privateNote);
      }
    },
    noCompanyWrites() {
      expect(stores.companyFiles.size).toBe(0);
      expect(stores.contributionReceipts).toHaveLength(0);
    },
    citations(observations: LocalObservation[]) {
      const ids = new Set(stores.transcript.map((s) => s.id));
      for (const o of observations) {
        expect(o.citations.length, `${o.id} citations`).toBeGreaterThan(0);
        for (const c of o.citations) expect(ids.has(c), `${o.id} cites ${c}`).toBe(true);
      }
    },
    entityLookup(query: string, expectedId: string | null) {
      expect(lookupEntity(query)).toBe(expectedId);
    },
    meetingsState(jobId: string | undefined, expected: MeetingsUiState) {
      expect(meetingsUiState(jobId)).toBe(expected);
    },
    guardFailed(reason: GuardFailure) {
      expect(guardLog.some((g) => !g.outcome.ok && g.outcome.reason === reason), `guard ${reason}`).toBe(true);
    },
    noModelProcess() {
      expect(processLaunches).toBe(0);
    },
  };

  return {
    stores,
    setProvider,
    providerReadiness,
    verifyAudienceReceipt,
    checkSourceContributable,
    checkPrefix,
    checkProjectionFresh,
    lookupEntity,
    submitRequest,
    runToCompletion,
    meetingsUiState,
    assert,
    get extractorCalls() {
      return extractorCalls;
    },
    get processLaunches() {
      return processLaunches;
    },
    guardLog,
  };
}

export type LocalSignalsHarness = ReturnType<typeof createLocalSignalsHarness>;
