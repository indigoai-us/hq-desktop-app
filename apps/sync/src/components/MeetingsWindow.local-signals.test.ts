/**
 * signals-local-meetings-v1 US-009 acceptance tests (UI half): one describe
 * per acceptance criterion (ac0..ac6), plus the Meetings halves of US-007 AC7
 * and US-008 AC5/AC6. The view model is pure; the structure checks read the
 * real MeetingsWindow.svelte source. Backend halves live in
 * src-tauri/src/local_signals/signals_local_meetings_v1_us009_acceptance.rs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_CHARS,
  RETRY_DELAYS_MS,
  emptyRowUi,
  isActive,
  nextRetryDelay,
  plainError,
  shouldUpload,
  signalsRowView,
  type MeetingSignalsStatus,
  type SignalsRowUi,
  type UploadSummary,
} from '../lib/localMeetingSignals';
import type { RunState } from '../desktop-alt/lib/local-signal-runs';

const SRC = readFileSync(resolve(__dirname, 'MeetingsWindow.svelte'), 'utf8');
const MAIN_RS = readFileSync(resolve(__dirname, '../../src-tauri/src/main.rs'), 'utf8');

function run(state: RunState, extra: Record<string, unknown> = {}): NonNullable<MeetingSignalsStatus['run']> {
  return {
    request: { jobId: 'job-1', provider: 'any' },
    state,
    status: '',
    history: [],
    updatedAt: '',
    claimedBy: null,
    providerSessionId: null,
    ownerPid: null,
    parsedResultDigest: null,
    activations: 1,
    recovery: null,
    ...extra,
  } as unknown as NonNullable<MeetingSignalsStatus['run']>;
}

function status(over: Partial<MeetingSignalsStatus> = {}): MeetingSignalsStatus {
  return { enabled: true, eligible: true, ineligibleReason: null, run: null, localComplete: false, upload: null, ...over };
}

function upload(over: Partial<UploadSummary> = {}): UploadSummary {
  return {
    total: 3, uploaded: 0, created: 0, unchanged: 0, repaired: 0, conflict: 0, ineligible: 0, blocked: 0,
    disabled: 0, retryable: 0, reasons: [], sent: 0, ...over,
  };
}

const ui = (over: Partial<SignalsRowUi> = {}): SignalsRowUi => ({ ...emptyRowUi(), ...over });
const labels = (s: MeetingSignalsStatus | null, u = ui()) => signalsRowView(s, u).actions.map((a) => a.label);

describe('US-009 ac0: Generate signals only when the flag is on and the source is eligible', () => {
  it('shows the action for an eligible completed meeting with the flag on', () => {
    const v = signalsRowView(status(), ui());
    expect(v.visible).toBe(true);
    expect(labels(status())).toEqual(['Generate signals']);
  });

  it('renders inside the existing completed (past) meeting row', () => {
    const past = SRC.slice(SRC.indexOf('{#each pastMeetingRows as row'));
    const botRow = past.slice(0, past.indexOf('{:else}'));
    expect(botRow).toContain('{@render localSignals(row.bot)}');
    expect(SRC).toMatch(/rowButtonKind\(bot\) === 'done'/);
    expect(SRC).toContain("invoke<MeetingSignalsStatus>('meeting_signals_status'");
    for (const cmd of ['meeting_signals_status', 'meeting_signals_generate', 'meeting_signals_open_session', 'meeting_signals_cancel', 'meeting_signals_upload']) {
      expect(MAIN_RS).toContain(`commands::meeting_signals::${cmd}`);
    }
  });
});

describe('US-009 ac1: immediate acknowledgement, no duplicates, every lifecycle state in place', () => {
  it('acknowledges at once and disables every action while submitting', () => {
    const v = signalsRowView(status(), ui({ submitting: true }));
    expect(v).toMatchObject({ visible: true, text: 'Starting…', busy: true, actions: [] });
    const handler = SRC.slice(SRC.indexOf('async function runSignalsAction'));
    expect(handler.indexOf('if (ui.submitting || ui.uploading) return;')).toBeGreaterThan(0);
    expect(handler.indexOf('setSignalsUi(bot.botId, { submitting: true')).toBeLessThan(handler.indexOf('await perform()'));
  });

  it('names every run state', () => {
    const texts: Record<string, string> = {};
    for (const s of ['pending', 'claimed', 'extracting', 'writing', 'uploading', 'complete', 'cancelled', 'failed'] as RunState[]) {
      texts[s] = signalsRowView(status({ run: run(s) }), ui()).text;
    }
    expect(texts).toEqual({
      pending: 'Waiting for Claude or Codex.',
      claimed: 'Picked up by Claude.',
      extracting: 'Reading the transcript…',
      writing: 'Saving signals on this device…',
      uploading: 'Sharing with your company…',
      complete: 'Signals ready.',
      cancelled: 'Cancelled.',
      failed: 'Signal generation stopped.',
    });
  });

  it('shows blocked and recoverable states', () => {
    expect(signalsRowView(status({ localComplete: true, upload: upload({ blocked: 3 }) }), ui()).text).toBe(
      'Signals ready on this device. They stay private.',
    );
    expect(signalsRowView(status({ run: run('pending', { recovery: 'resume' }) }), ui()).text).toBe(
      'The connection to Claude dropped. Progress is saved.',
    );
  });

  it('polls only while a job is moving', () => {
    expect(isActive(status({ run: run('extracting') }))).toBe(true);
    expect(isActive(status({ run: run('complete') }))).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});

describe('US-009 ac2: no provider session stays pending and names Claude or Codex', () => {
  it('pending offers only the two visible session launches and cancel', () => {
    const v = signalsRowView(status({ run: run('pending') }), ui());
    expect(v.text).toBe('Waiting for Claude or Codex.');
    expect(v.actions.map((a) => a.id)).toEqual(['open_claude', 'open_codex', 'cancel']);
  });

  it('the row never calls a cloud or headless extractor', () => {
    const block = SRC.slice(SRC.indexOf('// ── signals-local-meetings-v1 US-009'), SRC.indexOf('// Load status for completed rows'));
    const invoked = [...block.matchAll(/invoke(?:<[^>]+>)?\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(invoked)).toEqual(
      new Set(['meeting_signals_status', 'meeting_signals_upload', 'meeting_signals_generate', 'meeting_signals_cancel', 'meeting_signals_open_session']),
    );
    expect(block).not.toMatch(/fetch\(|\/v1\/signals|claude -p|codex exec/);
  });
});

describe('US-009 ac3: plain bounded failures, bounded auto-retry, persistent Tap to retry', () => {
  it('never echoes raw HTTP, JSON, invoke, stack, or transport text', () => {
    const raw = [
      'HTTP 502 Bad Gateway',
      '{"error":"Contribution failed validation","code":"CONTRIBUTION_REJECTED"}',
      'invoke error: command meeting_signals_upload not found',
      'Error: boom\n    at runSignalsAction (MeetingsWindow.svelte:12:3)',
      'error sending request for url (https://hqapi.hq.computer): connection reset',
      new Error('ECONNRESET'),
      { status: 500 },
    ];
    for (const r of raw) {
      const text = plainError(r);
      expect(text).toBe('Something went wrong.');
    }
    expect(plainError('offline')).toBe('Could not reach HQ.');
    expect(plainError('signed_out')).toBe('Sign in to HQ to continue.');
  });

  it('retries automatically on a bounded schedule, then leaves Tap to retry', () => {
    expect(RETRY_DELAYS_MS.length).toBe(3);
    expect([0, 1, 2, 3].map(nextRetryDelay)).toEqual([2000, 5000, 15000, null]);
    const retrying = signalsRowView(status(), ui({ error: 'Could not reach HQ.', autoRetrying: true }));
    expect(retrying).toMatchObject({ busy: true, actions: [] });
    expect(retrying.text).toContain('Retrying');
    const exhausted = signalsRowView(status(), ui({ error: 'Could not reach HQ.', attempts: 3 }));
    expect(exhausted.actions.map((a) => a.label)).toEqual(['Tap to retry']);
    expect(exhausted.busy).toBe(false);
  });

  it('keeps every line bounded', () => {
    const v = signalsRowView(status({ run: run('pending', { recovery: 'sign_in_again', status: 'x'.repeat(500) }) }), ui());
    expect(v.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it('raw detail is logged to diagnostics only', () => {
    const block = SRC.slice(SRC.indexOf('async function loadSignalStatus'), SRC.indexOf('// Load status for completed rows'));
    expect(block.match(/console\.warn\('\[local-signals\]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(block).not.toMatch(/error: String\(err\)|error: err\b|\.message/);
  });
});

describe('US-009 ac4: cancel and retry are scoped to the selected job', () => {
  it('cancel sends only this row’s job id', () => {
    const handler = SRC.slice(SRC.indexOf('async function runSignalsAction'));
    expect(handler).toContain('const jobId = status?.run?.request.jobId;');
    expect(handler).toContain("await invoke('meeting_signals_cancel', { jobId })");
    expect(handler).toContain('const status = signalStatus[bot.botId];');
  });

  it('a cancelled or failed row retries through the durable request', () => {
    expect(signalsRowView(status({ run: run('cancelled') }), ui()).actions.map((a) => a.id)).toEqual(['generate']);
    expect(signalsRowView(status({ run: run('failed') }), ui()).actions.map((a) => a.id)).toEqual(['retry']);
    const handler = SRC.slice(SRC.indexOf('async function runSignalsAction'));
    expect(handler).toMatch(/case 'generate':\s*case 'retry':\s*return invoke<MeetingSignalsStatus>\('meeting_signals_generate'/);
  });
});

describe('US-009 ac5: existing layout only, Corey UI constraints', () => {
  const css = (() => {
    const style = SRC.slice(SRC.indexOf('<style'));
    const start = style.indexOf('.signals-line {');
    const last = style.indexOf('.signals-action:disabled', start);
    return style.slice(start, style.indexOf('}', last) + 1);
  })();
  const snippet = SRC.slice(SRC.indexOf('{#snippet localSignals'), SRC.indexOf('{#snippet companyAssign'));

  it('adds no new screen, panel, modal, banner, or accent bar', () => {
    for (const bad of ['<dialog', 'modal', 'banner', 'panel', 'sheet', 'toast', '<div']) {
      expect(snippet.toLowerCase()).not.toContain(bad);
    }
    expect(css).not.toMatch(/border-left|box-shadow|background:(?!\s*transparent)/);
  });

  it('no rounded corners and no weight above 500', () => {
    for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) expect(m[1].trim()).toBe('0');
    for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(500);
  });

  it('color only carries semantic tone', () => {
    const colorRules = [...css.matchAll(/\.signals-line\[data-tone='([a-z]+)'\]/g)].map((m) => m[1]);
    expect(colorRules.sort()).toEqual(['active', 'danger', 'ok', 'warn']);
  });
});

describe('US-009 ac6: flag-off, missing flag, ineligible, and private never expose the action', () => {
  it('hides everything and fabricates no state', () => {
    const cases: Array<MeetingSignalsStatus | null> = [
      null,
      status({ enabled: false, eligible: false }),
      status({ eligible: false, ineligibleReason: 'private_source' }),
      status({ eligible: false, ineligibleReason: 'not_on_roster' }),
      status({ eligible: false, ineligibleReason: 'missing_receipt' }),
      // Even if a stale run leaked through, an ineligible row shows nothing.
      status({ eligible: false, ineligibleReason: 'digest_mismatch', run: run('complete'), localComplete: true }),
    ];
    for (const c of cases) {
      expect(signalsRowView(c, ui())).toEqual({ visible: false, text: '', tone: 'muted', actions: [], busy: false });
      expect(signalsRowView(c, ui({ submitting: true, error: 'x' })).visible).toBe(false);
    }
  });

  it('status failures leave the row empty rather than implying a run', () => {
    const load = SRC.slice(SRC.indexOf('async function loadSignalStatus'), SRC.indexOf('function scheduleSignalsRetry'));
    expect(load).toContain("console.warn('[local-signals] status failed', err);");
    expect(load).not.toContain('setSignalsUi');
  });
});

describe('US-007 ac7 (Meetings half): provider loss shows one named plain action', () => {
  it('sign-in and resume actions', () => {
    expect(labels(status({ run: run('pending', { recovery: 'sign_in_again', status: 'Claude signed out. Sign in again to continue.' }) }))).toEqual([
      'Sign in to Claude',
      'Cancel',
    ]);
    expect(labels(status({ run: run('pending', { recovery: 'sign_in_again', status: 'Codex signed out. Sign in again to continue.' }) }))).toEqual([
      'Sign in to Codex',
      'Cancel',
    ]);
    expect(labels(status({ run: run('extracting', { recovery: 'resume' }) }))).toEqual(['Resume', 'Cancel']);
    expect(signalsRowView(status({ run: run('pending', { recovery: 'sign_in_again' }) }), ui()).text).toBe('Claude signed out.');
  });
});

describe('US-008 ac5/ac6 (Meetings half): automatic upload and repair from the local receipt', () => {
  it('uploads once a local run completes, and not otherwise', () => {
    expect(shouldUpload(status({ localComplete: true }), ui())).toBe(true);
    expect(shouldUpload(status({ localComplete: true, upload: upload({ uploaded: 1 }) }), ui())).toBe(true);
    expect(shouldUpload(status({ localComplete: true, upload: upload({ uploaded: 3 }) }), ui())).toBe(false);
    expect(shouldUpload(status({ localComplete: false }), ui())).toBe(false);
    expect(shouldUpload(status({ localComplete: true, upload: upload({ disabled: 3 }) }), ui())).toBe(false);
    expect(shouldUpload(status({ localComplete: true, upload: upload({ retryable: 1 }) }), ui())).toBe(false);
    expect(shouldUpload(status({ localComplete: true }), ui({ uploading: true }))).toBe(false);
    expect(shouldUpload(status({ enabled: false, localComplete: true }), ui())).toBe(false);
  });

  it('shows the server outcome in plain words', () => {
    const v = (u: Partial<UploadSummary>, extra: Partial<SignalsRowUi> = {}) =>
      signalsRowView(status({ localComplete: true, upload: upload(u) }), ui(extra));
    expect(v({ uploaded: 3, created: 2, unchanged: 1 }).text).toBe('Signals ready.');
    expect(v({ uploaded: 2, repaired: 1, blocked: 1 }).text).toBe('Signals ready. 1 stay private on this device.');
    expect(v({ disabled: 3 })).toMatchObject({ text: 'Saved on this device. Sharing is off for this company.', actions: [{ label: 'Tap to retry' }] });
    expect(v({ ineligible: 3 }).text).toBe('Saved on this device. This meeting can’t be shared.');
    expect(v({ uploaded: 2, conflict: 1 }).text).toBe('Saved on this device. A different copy is already shared.');
    expect(v({ uploaded: 2, retryable: 1 }).actions.map((a) => a.label)).toEqual(['Tap to retry']);
    expect(v({ uploaded: 2, retryable: 1 }, { autoRetrying: true }).busy).toBe(true);
    expect(v({}, { uploading: true }).text).toBe('Sharing with your company…');
  });

  it('Tap to retry on a complete local run re-uploads, never re-extracts', () => {
    const handler = SRC.slice(SRC.indexOf('async function runSignalsAction'));
    expect(handler).toMatch(/if \(action === 'retry' && status\?\.localComplete\) \{\s*void uploadSignals\(bot, true\);\s*return;/);
  });
});
