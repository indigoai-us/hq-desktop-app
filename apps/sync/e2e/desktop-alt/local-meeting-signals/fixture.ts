import { createHash, createHmac } from 'node:crypto';

/**
 * signals-local-meetings-v1 US-001 — Phase 0 fixture.
 *
 * One completed bot-captured meeting plus everything the local signal flow
 * reads or writes: transcript, frozen invitation roster, the audience receipt
 * minted from that roster, a member-filtered identity projection, provider
 * session states, the expected local observations, and the company
 * contribution receipts. Everything is static data; nothing here touches the
 * network, a credential, or a model process.
 */

export const COMPANY_UID = 'cmp_fixture_indigo';
export const MEMBER_UID = 'prs_fixture_member_a';
export const OTHER_MEMBER_UID = 'prs_fixture_member_b';
export const MEETING_ID = 'mtg_fixture_weekly_sync';

/** Test-only key. The harness never reads a production signing secret. */
export const FIXTURE_RECEIPT_KEY = 'desktop-alt-fixture-receipt-key';

export const PROMPT_VERSION = 'local-signals-prompt/v1';
export const SCHEMA_VERSION = 'local-signal/v1';

export const SIGNAL_TYPES = [
  'decision',
  'action_item',
  'risk',
  'question',
  'commitment',
  'blocker',
  'insight',
  'request',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export interface TranscriptSegment {
  id: string;
  speaker: string;
  startMs: number;
  text: string;
}

export interface CompletedMeeting {
  companyUid: string;
  meetingId: string;
  title: string;
  capture: 'bot';
  status: 'completed';
  endedAt: string;
  sourceRef: string;
  visibility: 'company' | 'private';
}

export interface FrozenRoster {
  meetingId: string;
  frozenAt: string;
  invitees: { personUid: string; email: string }[];
}

export interface AudienceReceipt {
  companyUid: string;
  meetingId: string;
  rosterDigest: string;
  memberUids: string[];
  issuedAt: string;
  signature: string;
}

export interface ProjectionEntity {
  id: string;
  type: 'person' | 'project' | 'organization';
  name: string;
  aliases: string[];
}

export interface MemberProjection {
  companyUid: string;
  memberUid: string;
  generatedAt: string;
  /** Digest of the audience receipt the projection was filtered against. */
  audienceDigest: string;
  entities: ProjectionEntity[];
}

export type ProviderState = 'claude-ready' | 'codex-ready' | 'no-session';

export interface LocalObservation {
  id: string;
  type: SignalType;
  summary: string;
  citations: string[];
  entityRefs: string[];
  /** Sensitive detail that stays on device and must never reach the company vault. */
  privateNote?: string;
}

export interface ContributionReceipt {
  jobId: string;
  memberUid: string;
  companyPath: string;
  observationIds: string[];
  contentDigest: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signReceipt(receipt: Omit<AudienceReceipt, 'signature'>): string {
  return createHmac('sha256', FIXTURE_RECEIPT_KEY).update(canonicalJson(receipt)).digest('hex');
}

export const meeting: CompletedMeeting = {
  companyUid: COMPANY_UID,
  meetingId: MEETING_ID,
  title: 'Weekly product sync',
  capture: 'bot',
  status: 'completed',
  endedAt: '2026-10-12T17:30:00.000Z',
  sourceRef: `sources/meetings/${MEETING_ID}.md`,
  visibility: 'company',
};

export const transcript: TranscriptSegment[] = [
  { id: 'seg-001', speaker: 'Ava Chen', startMs: 0, text: 'We agreed to ship the Atlas beta on November 3.' },
  { id: 'seg-002', speaker: 'Ben Ortiz', startMs: 42_000, text: 'I will draft the Atlas launch checklist by Friday.' },
  { id: 'seg-003', speaker: 'Ava Chen', startMs: 88_000, text: 'Risk: the Northwind contract renewal could slip a quarter.' },
  { id: 'seg-004', speaker: 'Ben Ortiz', startMs: 131_000, text: 'Open question: who owns the billing migration?' },
  { id: 'seg-005', speaker: 'Ava Chen', startMs: 170_000, text: 'Blocked until legal signs the Northwind data addendum.' },
];

export const transcriptMarkdown = transcript
  .map((s) => `[${s.id}] **${s.speaker}:** ${s.text}`)
  .join('\n');

export const sourceDigest = sha256(transcriptMarkdown);

export const roster: FrozenRoster = {
  meetingId: MEETING_ID,
  frozenAt: '2026-10-12T16:55:00.000Z',
  invitees: [
    { personUid: MEMBER_UID, email: 'ava@example.test' },
    { personUid: OTHER_MEMBER_UID, email: 'ben@example.test' },
  ],
};

export const rosterDigest = sha256(canonicalJson(roster));

const unsignedReceipt: Omit<AudienceReceipt, 'signature'> = {
  companyUid: COMPANY_UID,
  meetingId: MEETING_ID,
  rosterDigest,
  memberUids: roster.invitees.map((i) => i.personUid),
  issuedAt: '2026-10-12T17:31:00.000Z',
};

export const audienceReceipt: AudienceReceipt = {
  ...unsignedReceipt,
  signature: signReceipt(unsignedReceipt),
};

export const audienceDigest = sha256(canonicalJson(audienceReceipt));

export const projection: MemberProjection = {
  companyUid: COMPANY_UID,
  memberUid: MEMBER_UID,
  generatedAt: '2026-10-12T17:32:00.000Z',
  audienceDigest,
  entities: [
    { id: 'ent-person-ava', type: 'person', name: 'Ava Chen', aliases: ['Ava'] },
    { id: 'ent-person-ben', type: 'person', name: 'Ben Ortiz', aliases: ['Ben'] },
    { id: 'ent-project-atlas', type: 'project', name: 'Atlas', aliases: ['Atlas beta'] },
    { id: 'ent-org-northwind', type: 'organization', name: 'Northwind', aliases: [] },
  ],
};

export const providerFixtures: Record<ProviderState, { provider: 'claude' | 'codex' | null; sessionId: string | null }> = {
  'claude-ready': { provider: 'claude', sessionId: 'claude-session-fixture' },
  'codex-ready': { provider: 'codex', sessionId: 'codex-session-fixture' },
  'no-session': { provider: null, sessionId: null },
};

/** What a scripted extractor returns for the fixture meeting: one signal per type. */
export const localObservations: LocalObservation[] = [
  { id: 'obs-decision-1', type: 'decision', summary: 'Ship the Atlas beta on November 3.', citations: ['seg-001'], entityRefs: ['ent-project-atlas'] },
  { id: 'obs-action-1', type: 'action_item', summary: 'Ben drafts the Atlas launch checklist by Friday.', citations: ['seg-002'], entityRefs: ['ent-person-ben', 'ent-project-atlas'] },
  { id: 'obs-risk-1', type: 'risk', summary: 'Northwind renewal could slip a quarter.', citations: ['seg-003'], entityRefs: ['ent-org-northwind'], privateNote: 'Ava suspects Northwind budget cuts.' },
  { id: 'obs-question-1', type: 'question', summary: 'Who owns the billing migration?', citations: ['seg-004'], entityRefs: [] },
  { id: 'obs-commitment-1', type: 'commitment', summary: 'Ben committed to the checklist deadline.', citations: ['seg-002'], entityRefs: ['ent-person-ben'] },
  { id: 'obs-blocker-1', type: 'blocker', summary: 'Northwind data addendum awaits legal signature.', citations: ['seg-005'], entityRefs: ['ent-org-northwind'] },
  { id: 'obs-insight-1', type: 'insight', summary: 'Atlas launch depends on Northwind timing.', citations: ['seg-001', 'seg-003'], entityRefs: ['ent-project-atlas', 'ent-org-northwind'] },
  { id: 'obs-request-1', type: 'request', summary: 'Assign an owner for the billing migration.', citations: ['seg-004'], entityRefs: [] },
];

export function memberPrefix(companyUid: string, memberUid: string): string {
  return `companies/${companyUid}/member-signals/${memberUid}/`;
}

// ── Negative fixtures ────────────────────────────────────────────────────────

export const negative = {
  /** A meeting the member may read locally but that must never be contributed. */
  privateSource: { ...meeting, meetingId: 'mtg_fixture_private_1on1', visibility: 'private' as const },
  /** A contribution path under a different member's intake prefix. */
  otherMemberPrefixPath: `${memberPrefix(COMPANY_UID, OTHER_MEMBER_UID)}${MEETING_ID}/observations.md`,
  /** A projection filtered against an older audience receipt. */
  staleProjection: { ...projection, audienceDigest: sha256('superseded-audience-receipt') },
  /** A receipt whose member list was edited after signing. */
  tamperedReceipt: { ...audienceReceipt, memberUids: [...audienceReceipt.memberUids, 'prs_fixture_intruder'] },
} as const;
