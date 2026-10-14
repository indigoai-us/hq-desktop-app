import type { RunRecord } from '../desktop-alt/lib/local-signal-runs';

/**
 * signals-local-meetings-v1 US-009 — view model for the Generate signals line
 * on a completed Meetings row. Pure: MeetingsWindow.svelte feeds it the
 * backend status (`meeting_signals_status`) and the row's local UI state, and
 * renders exactly what comes back. All member-facing text is plain, short,
 * and fixed here; raw errors never reach it (see `plainError`).
 */

export type IneligibleReason =
  | 'missing_source'
  | 'private_source'
  | 'missing_receipt'
  | 'wrong_company'
  | 'not_bot_capture'
  | 'audience_mismatch'
  | 'digest_mismatch'
  | 'not_on_roster';

export interface UploadSummary {
  total: number;
  uploaded: number;
  created: number;
  unchanged: number;
  repaired: number;
  conflict: number;
  ineligible: number;
  blocked: number;
  disabled: number;
  retryable: number;
  reasons: string[];
  sent: number;
}

export interface MeetingSignalsStatus {
  enabled: boolean;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  run: (RunRecord & { recovery?: string | null }) | null;
  localComplete: boolean;
  upload: UploadSummary | null;
}

export type SignalsAction =
  | 'view'
  | 'generate'
  | 'cancel'
  | 'retry'
  | 'open_claude'
  | 'open_codex'
  | 'sign_in_claude'
  | 'sign_in_codex'
  | 'resume';

/** Recoverable failures are muted, never red (indigo-ui-never-raw-errors-always-heal-path). */
export type SignalsTone = 'muted' | 'active' | 'ok' | 'warn';

export interface SignalsRowUi {
  /** True from the click until the backend answers. Blocks duplicates. */
  submitting: boolean;
  /** True while an automatic upload pass is in flight. */
  uploading: boolean;
  /** Plain failure copy, or null. */
  error: string | null;
  /** Automatic retries already used for the current failure. */
  attempts: number;
  /** An automatic retry is scheduled. */
  autoRetrying: boolean;
}

export interface SignalsRowView {
  visible: boolean;
  text: string;
  tone: SignalsTone;
  actions: Array<{ id: SignalsAction; label: string }>;
  busy: boolean;
}

export const MAX_TEXT_CHARS = 96;
/** Automatic retry schedule. After the last one, only Tap to retry remains. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

export function emptyRowUi(): SignalsRowUi {
  return { submitting: false, uploading: false, error: null, attempts: 0, autoRetrying: false };
}

const HIDDEN: SignalsRowView = { visible: false, text: '', tone: 'muted', actions: [], busy: false };

function bounded(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_TEXT_CHARS ? clean : `${clean.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

function view(text: string, tone: SignalsTone, actions: SignalsRowView['actions'] = [], busy = false): SignalsRowView {
  return { visible: true, text: bounded(text), tone, actions, busy };
}

const GENERATE = { id: 'generate' as const, label: 'Generate signals' };
const RETRY = { id: 'retry' as const, label: 'Tap to retry' };
const CANCEL = { id: 'cancel' as const, label: 'Cancel' };

/** Plain copy for any failure. Known backend codes get specific text; the rest never echo raw detail. */
export function plainError(err: unknown): string {
  const code = typeof err === 'string' ? err.trim() : '';
  switch (code) {
    case 'signed_out':
    case 'auth':
      return 'Sign in to HQ to continue.';
    case 'offline':
    case 'transport':
      return 'Could not reach HQ.';
    case 'disabled':
      return 'Signals are turned off for this company.';
    case 'not_eligible':
      return 'This meeting can’t be used for signals.';
    case 'session_launch_failed':
      return 'Could not open the session.';
    default:
      return 'Something went wrong.';
  }
}

/** Delay before the next automatic retry, or null when only Tap to retry remains. */
export function nextRetryDelay(attempts: number): number | null {
  return attempts < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempts] : null;
}

export function providerName(run: NonNullable<MeetingSignalsStatus['run']>): 'Claude' | 'Codex' {
  if (/codex/i.test(run.status ?? '') || run.claimedBy === 'codex') return 'Codex';
  if (run.request.provider === 'codex') return 'Codex';
  return 'Claude';
}

/** Should the row start an automatic upload pass now? */
export function shouldUpload(status: MeetingSignalsStatus | null, ui: SignalsRowUi): boolean {
  if (!status?.enabled || !status.eligible || !status.localComplete) return false;
  if (ui.uploading || ui.submitting || ui.error) return false;
  const u = status.upload;
  if (!u) return true;
  // Turned off, or failed and waiting on the retry schedule / Tap to retry.
  if (u.disabled > 0 || u.retryable > 0) return false;
  return u.uploaded + u.conflict + u.ineligible + u.blocked < u.total;
}

/** Is the job still moving, so the row should keep polling? */
export function isActive(status: MeetingSignalsStatus | null): boolean {
  const s = status?.run?.state;
  return s === 'pending' || s === 'claimed' || s === 'extracting' || s === 'writing' || s === 'uploading';
}

function uploadView(u: UploadSummary | null, ui: SignalsRowUi): SignalsRowView {
  if (ui.uploading || !u) return view('Sharing with your company…', 'active', [], true);
  if (u.disabled > 0) return view('Saved on this device. Sharing is off for this company.', 'muted', [RETRY]);
  if (u.ineligible > 0) return view('Saved on this device. This meeting can’t be shared.', 'warn');
  if (u.conflict > 0) return view('Saved on this device. A different copy is already shared.', 'warn');
  if (u.retryable > 0) {
    return ui.autoRetrying
      ? view('Saved on this device. Retrying the share…', 'active', [], true)
      : view('Saved on this device. Sharing didn’t finish.', 'warn', [RETRY]);
  }
  const settled = u.uploaded + u.blocked;
  if (settled < u.total) return view('Sharing with your company…', 'active', [], true);
  if (u.uploaded === 0) return view('Signals ready on this device. They stay private.', 'muted');
  if (u.blocked > 0) return view(`Signals ready. ${u.blocked} stay private on this device.`, 'ok');
  return view('Signals ready.', 'ok');
}

export function signalsRowView(
  status: MeetingSignalsStatus | null,
  ui: SignalsRowUi,
  expanded = false,
): SignalsRowView {
  // Flag off, missing, or unreadable; ineligible or private source: nothing at all.
  if (!status || !status.enabled || !status.eligible) return HIDDEN;
  if (ui.submitting) return view('Starting…', 'active', [], true);
  if (ui.error) {
    return ui.autoRetrying
      ? view(`${ui.error} Retrying…`, 'muted', [], true)
      : view(ui.error, 'muted', [RETRY]);
  }
  if (status.localComplete) {
    // US-010: a complete local run can always be read in place.
    const v = uploadView(status.upload, ui);
    return { ...v, actions: [...v.actions, { id: 'view', label: expanded ? 'Hide signals' : 'View signals' }] };
  }

  const run = status.run;
  if (!run) return view('', 'muted', [GENERATE]);

  const name = providerName(run);
  if (run.recovery === 'sign_in_again') {
    return view(`${name} signed out.`, 'warn', [
      { id: name === 'Codex' ? 'sign_in_codex' : 'sign_in_claude', label: `Sign in to ${name}` },
      CANCEL,
    ]);
  }
  if (run.recovery === 'resume') {
    return view(`The connection to ${name} dropped. Progress is saved.`, 'warn', [{ id: 'resume', label: 'Resume' }, CANCEL]);
  }
  switch (run.state) {
    case 'pending':
      return view('Waiting for Claude or Codex.', 'muted', [
        { id: 'open_claude', label: 'Open in Claude' },
        { id: 'open_codex', label: 'Open in Codex' },
        CANCEL,
      ]);
    case 'claimed':
      return view(`Picked up by ${name}.`, 'active', [CANCEL]);
    case 'extracting':
      return view('Reading the transcript…', 'active', [CANCEL]);
    case 'writing':
      return view('Saving signals on this device…', 'active', [CANCEL]);
    case 'uploading':
      return view('Sharing with your company…', 'active', [], true);
    case 'complete':
      return view('Signals ready.', 'ok');
    case 'cancelled':
      return view('Cancelled.', 'muted', [GENERATE]);
    case 'failed':
      return view('Signal generation stopped.', 'muted', [RETRY]);
    default:
      return HIDDEN;
  }
}

// ── US-010: cited local results inside the Meetings row ─────────────────────

export type SignalType =
  | 'summary'
  | 'key_point'
  | 'decision'
  | 'action_item'
  | 'participant_contribution'
  | 'risk'
  | 'commitment'
  | 'question';

export const SIGNAL_TYPE_ORDER: readonly SignalType[] = [
  'summary',
  'key_point',
  'decision',
  'action_item',
  'participant_contribution',
  'risk',
  'commitment',
  'question',
];

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  summary: 'Summary',
  key_point: 'Key points',
  decision: 'Decisions',
  action_item: 'Action items',
  participant_contribution: 'Contributions',
  risk: 'Risks',
  commitment: 'Commitments',
  question: 'Questions',
};

export type UploadBadge = 'pending' | 'uploaded' | 'private' | 'ineligible' | 'retry' | 'off' | 'conflict';

/** Plain upload copy. Never names server reasons or what sanitizing removed. */
export const UPLOAD_BADGE_LABELS: Record<UploadBadge, string> = {
  pending: 'Not shared yet',
  uploaded: 'Shared with your company',
  private: 'Stays on this device',
  ineligible: 'Can’t be shared',
  retry: 'Sharing will retry',
  off: 'Sharing is off',
  conflict: 'A different copy is shared',
};

export interface ResultCitation {
  startMs: number;
  endMs: number;
  label: string;
  valid: boolean;
}

export interface ResultEntity {
  name: string;
  entityId: string | null;
  provisional: boolean;
}

export interface ResultItem {
  observationId: string;
  signalType: SignalType;
  content: string;
  citations: ResultCitation[];
  entities: ResultEntity[];
  owner: string | null;
  reasoning: string | null;
  speaker: string | null;
  provider: string;
  model: string;
  projectionState: string;
  upload: UploadBadge;
}

export interface ResultVersion {
  status: 'pending' | 'complete' | 'superseded';
  promptVersion: string;
  schemaVersion: string;
  currentTranscript: boolean;
  groups: Array<{ signalType: SignalType; items: ResultItem[] }>;
  missing: number;
}

export interface MeetingResults {
  current: ResultVersion | null;
  history: ResultVersion[];
}

export interface ResultGroupView {
  signalType: SignalType;
  label: string;
  items: ResultItemView[];
}

export interface ResultItemView {
  observationId: string;
  content: string;
  detail: string | null;
  citations: ResultCitation[];
  entities: Array<{ label: string; title: string; provisional: boolean }>;
  source: string;
  upload: string;
  uploadTone: SignalsTone;
}

function providerLabel(provider: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Interactive session';
}

function projectionLabel(state: string): string | null {
  switch (state) {
    case 'ready':
      return null;
    case 'stale':
      return 'stale company context';
    case 'disabled':
      return 'company context off';
    case 'missing':
      return 'no company context';
    default:
      return 'company context unknown';
  }
}

const BADGE_TONE: Record<UploadBadge, SignalsTone> = {
  pending: 'muted',
  uploaded: 'ok',
  private: 'muted',
  ineligible: 'warn',
  retry: 'warn',
  off: 'muted',
  conflict: 'warn',
};

export function resultItemView(item: ResultItem): ResultItemView {
  const detail =
    item.signalType === 'action_item' && item.owner
      ? `Owner: ${item.owner}`
      : item.signalType === 'decision' && item.reasoning
        ? `Why: ${item.reasoning}`
        : item.signalType === 'participant_contribution' && item.speaker
          ? `Speaker: ${item.speaker}`
          : null;
  const projection = projectionLabel(item.projectionState);
  return {
    observationId: item.observationId,
    content: item.content,
    detail: detail ? bounded(detail) : null,
    citations: item.citations,
    entities: item.entities.map((e) => ({
      label: e.provisional ? `${e.name} (new)` : e.name,
      title: e.provisional ? 'Not yet in your company’s records' : (e.entityId ?? ''),
      provisional: e.provisional,
    })),
    source: [providerLabel(item.provider), projection].filter(Boolean).join(' · '),
    upload: UPLOAD_BADGE_LABELS[item.upload] ?? UPLOAD_BADGE_LABELS.pending,
    uploadTone: BADGE_TONE[item.upload] ?? 'muted',
  };
}

/** All eight types in canonical order, each with its items. */
export function resultGroupsView(version: ResultVersion | null): ResultGroupView[] {
  if (!version) return [];
  return SIGNAL_TYPE_ORDER.map((type) => ({
    signalType: type,
    label: SIGNAL_TYPE_LABELS[type],
    items: (version.groups.find((g) => g.signalType === type)?.items ?? []).map(resultItemView),
  }));
}

/** Plain copy when a citation cannot be shown. */
export function citationError(_err: unknown): string {
  return 'This citation can’t be shown.';
}
