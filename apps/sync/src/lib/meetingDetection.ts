//! Pure orchestration for the `meeting:detected` → (popover row +
//! notification) decision, extracted from `App.svelte` so the bot-dedup
//! rule is unit-testable without mounting the component or mocking Tauri
//! IPC.
//!
//! ## The bug this guards
//!
//! A meeting already covered by an active hq-pro bot — a scheduled calendar
//! bot, or one already in the call — must surface **neither** a recordable
//! popover row **nor** a macOS notification. The bot is already handling it.
//!
//! The previous inline handler added the "detected" row *unconditionally,
//! before* the bot check, and only the notification path honoured the
//! dedup (`if (bot) return`). So a fully-scheduled calendar meeting still
//! showed "you could record this" in the popover even while its bot was
//! recording. This module makes the row and the notification share one
//! decision.

/** Raw `meeting:detected` event payload — the subset the handler reads. */
export interface MeetingDetectedPayload {
  /** The meeting URL (Zoom/Meet/Teams) or a synthetic `recall-window:<id>`. */
  meetingUrl?: string;
  /** Lowercase platform discriminator from the SDK (`zoom`, `meet`, …). */
  platform?: string;
  /** Meeting title / calendar summary, if known. */
  summary?: string;
  /** SDK source calendar-event id — secondary dedup key alongside the URL. */
  sourceEventId?: string;
  /** Canonical SDK window handle (newer bridge versions include it directly). */
  windowId?: string;
}

/**
 * Row seed handed to the store when a detection should surface as a
 * recordable meeting. Carries every non-optional `ActiveMeeting` field plus
 * the two seed defaults (`state: 'detected'`, `companyUserSet: false`), so
 * it is assignable to `App.svelte`'s `ActiveMeeting`.
 */
export interface DetectedMeetingSeed {
  windowId: string;
  platform: string;
  meetingUrl: string;
  detectedAt: string;
  state: 'detected';
  companyUid: string | null;
  companyUserSet: false;
}

/** Payload forwarded to the `meetings_notify_detected` Tauri command. */
export interface NotifyDetectedPayload {
  meetingUrl: string | null;
  windowId: string | null;
  platform: string | null;
  summary: string | null;
  sourceEventId: string | null;
}

/**
 * Side-effecting collaborators, injected so the handler stays pure and the
 * test can observe every decision with plain fakes.
 */
export interface MeetingDetectedDeps {
  /**
   * Resolve whether hq-pro already has an *active* bot for this meeting.
   * Implementations should resolve `false` for the "no bot" case; a thrown
   * error is treated as **fail-open** (surface the detection) — better to
   * over-surface once than silently swallow a real meeting.
   */
  checkActiveBot: (meetingUrl: string, eventId: string | null) => Promise<boolean>;
  /** Add/update the in-popover "detected" row (the Record affordance). */
  upsertRow: (seed: DetectedMeetingSeed) => void;
  /** Remove a row by window id (clears a stale row once a bot is found). */
  removeRow: (windowId: string) => void;
  /** Fire the macOS "Meeting detected" notification. */
  notify: (payload: NotifyDetectedPayload) => Promise<void>;
  /** Current valid default recording company UID (or null = Personal). */
  resolveValidDefault: () => string | null;
  /**
   * Whether "Record meetings automatically" is on. A thrown error is treated
   * as **fail-closed** (no automatic recording) — never record someone
   * without a readable opt-in.
   */
  autoRecordEnabled: () => Promise<boolean>;
  /** Start recording the SDK window (same path as a Record click). */
  startRecording: (windowId: string) => Promise<void>;
  /**
   * Whether the detection for this window is still open. Checked right before
   * an automatic start: `meeting:closed` can land while the bot check or the
   * alert is in flight, and starting a closed window mints an upload token
   * and a ledger entry for a recording that can never run.
   */
  isStillActive: (windowId: string) => boolean;
  /** ISO-8601 "now" — injected so tests are deterministic. */
  now: () => string;
  /** Optional diagnostic sink for a failed (fail-open) bot check. */
  warn?: (msg: string, err: unknown) => void;
}

/**
 * Derive the stable window id for a detection.
 *
 * Prefers the explicit `windowId` field (canonical SDK handle on newer
 * bridges). Falls back to extracting it from a synthetic
 * `recall-window:<id>` URL (URL-less detections / older bridge), and last
 * of all uses the real `meetingUrl` itself as a dedup-only key.
 */
export function resolveWindowId(payload: MeetingDetectedPayload): {
  windowId: string;
  isSyntheticUrl: boolean;
} {
  const { meetingUrl } = payload;
  const isSyntheticUrl =
    typeof meetingUrl === 'string' && meetingUrl.startsWith('recall-window:');
  const windowId =
    payload.windowId ??
    (isSyntheticUrl
      ? meetingUrl!.slice('recall-window:'.length)
      : (meetingUrl ?? ''));
  return { windowId, isSyntheticUrl };
}

/**
 * Handle a single `meeting:detected` event.
 *
 * Flow:
 *   1. Resolve the window id.
 *   2. If the URL is real (not synthetic), ask hq-pro whether an active bot
 *      already covers it. Synthetic `recall-window:<id>` URLs can never have
 *      a bot, so skip the lookup. A failed lookup fails open for the row and
 *      alert, but blocks auto-record (a bot may already be recording).
 *   3. **Covered by a bot** → clear any stale row for this window and return
 *      without notifying. Neither surface appears.
 *   4. **Not covered** → seed the recordable row and fire the notification.
 *   5. When auto-record is on, the bot check succeeded, the detection carries
 *      an SDK window handle, and the meeting is still open, start recording.
 *      The alert goes first: `start_recording` marks the meeting Recorded in
 *      the notify ledger, which would otherwise suppress this alert.
 */
export async function handleMeetingDetected(
  payload: MeetingDetectedPayload,
  deps: MeetingDetectedDeps,
): Promise<void> {
  const { meetingUrl, platform, summary, sourceEventId } = payload;
  const { windowId, isSyntheticUrl } = resolveWindowId(payload);

  let hasActiveBot = false;
  let botCheckFailed = false;
  if (meetingUrl && !isSyntheticUrl) {
    try {
      hasActiveBot = await deps.checkActiveBot(meetingUrl, sourceEventId ?? null);
    } catch (botErr) {
      botCheckFailed = true;
      deps.warn?.('meetings_check_bot_for_url failed, continuing to notify:', botErr);
    }
  }

  if (hasActiveBot) {
    // Already handled by a bot. Clear any row an earlier detection of this
    // same window may have added (e.g. detected before the scheduled bot
    // joined), then bail — no recordable row, no notification.
    if (windowId) deps.removeRow(windowId);
    return;
  }

  if (windowId) {
    // Seed the row with the current valid default. May be null if the
    // default-company context hasn't loaded yet — `companyUserSet: false`
    // marks this as a non-explicit seed so the loader's back-fill and the
    // start-time resolver can both safely overwrite it.
    deps.upsertRow({
      windowId,
      platform: platform ?? 'other',
      meetingUrl: meetingUrl ?? '',
      detectedAt: deps.now(),
      state: 'detected',
      companyUid: deps.resolveValidDefault(),
      companyUserSet: false,
    });
  }

  const notifyPayload: NotifyDetectedPayload = {
    meetingUrl: meetingUrl ?? null,
    // Pass through so the notification's action-button thread can route a
    // Record click back to start_recording.
    windowId: windowId || null,
    platform: platform ?? null,
    summary: summary ?? null,
    sourceEventId: sourceEventId ?? null,
  };

  // Auto-record needs the SDK window handle: an explicit `windowId`, or one
  // recovered from a synthetic `recall-window:<id>` URL. The real-URL fallback
  // from `resolveWindowId` is only a dedup key the recorder cannot address.
  const autoRecordable =
    !!windowId && !botCheckFailed && (!!payload.windowId || isSyntheticUrl);
  if (!autoRecordable) {
    await deps.notify(notifyPayload);
    return;
  }

  let autoRecord = false;
  try {
    autoRecord = await deps.autoRecordEnabled();
  } catch (err) {
    deps.warn?.('meetings_auto_record_enabled failed, not auto-recording:', err);
  }
  if (!autoRecord) {
    await deps.notify(notifyPayload);
    return;
  }

  // Auto-recording: a failed alert must not cancel the recording.
  try {
    await deps.notify(notifyPayload);
  } catch (err) {
    deps.warn?.('meeting alert failed, auto-recording anyway:', err);
  }
  if (!deps.isStillActive(windowId)) return;
  try {
    await deps.startRecording(windowId);
  } catch (err) {
    deps.warn?.('auto-record start failed:', err);
  }
}

/**
 * Run detections the backend retained before this window's listener was
 * installed (the SDK can detect an already-open call before the webview
 * mounts) through the same decision as a live `meeting:detected`. The notify
 * ledger dedups any alert that already fired. Windows in `recordingWindowIds`
 * are already recording and are skipped: re-seeding them would reset the row
 * to `detected` and dispatch a start the recorder never confirms. One failure
 * never stops the rest.
 */
export async function replayRetainedDetections(
  detections: MeetingDetectedPayload[],
  recordingWindowIds: ReadonlySet<string>,
  deps: MeetingDetectedDeps,
): Promise<void> {
  for (const detection of detections) {
    if (recordingWindowIds.has(resolveWindowId(detection).windowId)) continue;
    try {
      await handleMeetingDetected(detection, deps);
    } catch (err) {
      deps.warn?.('retained meeting detection failed:', err);
    }
  }
}

/**
 * A Record click (or automatic start) on a meeting that is already recording
 * must do nothing. The recorder answers with the existing recording id and
 * never emits another `recording:started`, so a new acknowledged start would
 * time out and flip the live recording row to an error.
 */
export function startIsNoOp(state: string | undefined): boolean {
  return state === 'recording';
}
