import { describe, expect, it } from 'vitest';
import {
  handleMeetingDetected,
  replayRetainedDetections,
  resolveWindowId,
  startIsNoOp,
  type MeetingDetectedDeps,
  type DetectedMeetingSeed,
  type NotifyDetectedPayload,
} from './meetingDetection';

/**
 * Build a deps bundle whose collaborators record every call, so each test
 * can assert exactly which surfaces fired. `checkActiveBot` defaults to "no
 * bot" (the common ad-hoc-meeting case); override per test.
 */
function makeDeps(overrides: Partial<MeetingDetectedDeps> = {}): {
  deps: MeetingDetectedDeps;
  calls: {
    upsert: DetectedMeetingSeed[];
    remove: string[];
    notify: NotifyDetectedPayload[];
    botChecks: Array<[string, string | null]>;
    autoStarts: string[];
  };
} {
  const calls = {
    upsert: [] as DetectedMeetingSeed[],
    remove: [] as string[],
    notify: [] as NotifyDetectedPayload[],
    botChecks: [] as Array<[string, string | null]>,
    autoStarts: [] as string[],
  };
  const deps: MeetingDetectedDeps = {
    checkActiveBot: async (url, eventId) => {
      calls.botChecks.push([url, eventId]);
      return false;
    },
    upsertRow: (seed) => {
      calls.upsert.push(seed);
    },
    removeRow: (wid) => {
      calls.remove.push(wid);
    },
    notify: async (payload) => {
      calls.notify.push(payload);
    },
    resolveValidDefault: () => null,
    // Auto-record ships OFF by default — mirror that here so every existing
    // test keeps asserting the prompt-only behaviour.
    autoRecordEnabled: async () => false,
    startRecording: async (windowId) => {
      calls.autoStarts.push(windowId);
    },
    isStillActive: () => true,
    now: () => '2026-05-28T00:00:00.000Z',
    warn: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe('handleMeetingDetected', () => {
  it('suppresses BOTH the row and the notification when an active bot already covers the meeting', async () => {
    // Regression guard. The old handler upserted the popover row
    // unconditionally *before* the bot check and only `return`ed out of the
    // notification — so a scheduled calendar meeting (covered by its bot)
    // still rendered a "you could record this" row in the popover forever.
    const { deps, calls } = makeDeps({ checkActiveBot: async () => true });

    await handleMeetingDetected(
      {
        meetingUrl: 'https://zoom.us/j/123',
        platform: 'zoom',
        windowId: 'win-1',
        sourceEventId: 'evt-1',
      },
      deps,
    );

    expect(calls.upsert).toHaveLength(0); // no recordable row
    expect(calls.notify).toHaveLength(0); // no notification
    expect(calls.remove).toEqual(['win-1']); // any stale row cleared
  });

  it('surfaces row + notification when no bot covers the meeting', async () => {
    const { deps, calls } = makeDeps({ checkActiveBot: async () => false });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', platform: 'zoom', windowId: 'win-2' },
      deps,
    );

    expect(calls.upsert).toHaveLength(1);
    expect(calls.upsert[0]).toMatchObject({
      windowId: 'win-2',
      platform: 'zoom',
      state: 'detected',
      companyUserSet: false,
    });
    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0].windowId).toBe('win-2');
    expect(calls.remove).toHaveLength(0);
  });

  it('skips the bot check for synthetic recall-window URLs and always surfaces', async () => {
    // URL-less SDK detections (unscheduled meetings) carry a synthetic
    // `recall-window:<id>` URL hq-pro can't match — never query it, always
    // surface so the user can still record ad-hoc.
    const { deps, calls } = makeDeps();

    await handleMeetingDetected({ meetingUrl: 'recall-window:abc', platform: 'zoom' }, deps);

    expect(calls.botChecks).toHaveLength(0);
    expect(calls.upsert).toHaveLength(1);
    expect(calls.upsert[0].windowId).toBe('abc'); // id extracted from synthetic URL
    expect(calls.notify).toHaveLength(1);
  });

  it('fails open (surfaces) when the bot check throws', async () => {
    const warnings: unknown[] = [];
    const { deps, calls } = makeDeps({
      checkActiveBot: async () => {
        throw new Error('network down');
      },
      warn: (_msg, err) => warnings.push(err),
    });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', platform: 'zoom', windowId: 'win-3' },
      deps,
    );

    expect(calls.upsert).toHaveLength(1);
    expect(calls.notify).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('passes meetingUrl + sourceEventId through to the bot check', async () => {
    const { deps, calls } = makeDeps();

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', windowId: 'w', sourceEventId: 'evt-9' },
      deps,
    );

    expect(calls.botChecks[0]).toEqual(['https://zoom.us/j/123', 'evt-9']);
  });

  it('seeds the row with the resolved default company', async () => {
    const { deps, calls } = makeDeps({
      checkActiveBot: async () => false,
      resolveValidDefault: () => 'cmp_123',
    });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', windowId: 'win-4' },
      deps,
    );

    expect(calls.upsert[0].companyUid).toBe('cmp_123');
    expect(calls.upsert[0].detectedAt).toBe('2026-05-28T00:00:00.000Z');
  });
});

describe('handleMeetingDetected — auto-record', () => {
  it('does not start a recording when auto-record is off (the default)', async () => {
    const { deps, calls } = makeDeps();

    await handleMeetingDetected(
      { meetingUrl: 'recall-window:huddle-1', windowId: 'huddle-1', platform: 'slack' },
      deps,
    );

    expect(calls.autoStarts).toHaveLength(0);
    expect(calls.upsert).toHaveLength(1);
    expect(calls.notify).toHaveLength(1);
  });

  it.each(['slack', 'zoom', 'meet', 'teams', 'webex', 'other'])(
    'starts recording a detected %s meeting when auto-record is on',
    async (platform) => {
      const { deps, calls } = makeDeps({ autoRecordEnabled: async () => true });

      await handleMeetingDetected(
        { meetingUrl: 'recall-window:win-a', windowId: 'win-a', platform },
        deps,
      );

      expect(calls.autoStarts).toEqual(['win-a']);
      // The row is seeded before the start so the recording state machine has
      // a row to flip, and the user still gets told a meeting was detected.
      expect(calls.upsert).toHaveLength(1);
      expect(calls.notify).toHaveLength(1);
    },
  );

  it('seeds the row, then sends the alert, then starts the recording', async () => {
    // The alert must be claimed before the start: `start_recording` marks the
    // meeting Recorded in the notify ledger, which would suppress the alert.
    const order: string[] = [];
    const { deps } = makeDeps({
      autoRecordEnabled: async () => true,
      upsertRow: () => {
        order.push('upsert');
      },
      notify: async () => {
        order.push('notify');
      },
      startRecording: async () => {
        order.push('start');
      },
    });

    await handleMeetingDetected(
      { meetingUrl: 'recall-window:win-b', windowId: 'win-b', platform: 'zoom' },
      deps,
    );

    expect(order).toEqual(['upsert', 'notify', 'start']);
  });

  it('still auto-records when sending the alert fails', async () => {
    const warnings: unknown[] = [];
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      notify: async () => {
        throw new Error('banner failed');
      },
      warn: (_msg, err) => warnings.push(err),
    });

    await handleMeetingDetected(
      { meetingUrl: 'recall-window:win-n', windowId: 'win-n', platform: 'zoom' },
      deps,
    );

    expect(calls.autoStarts).toEqual(['win-n']);
    expect(warnings).toHaveLength(1);
  });

  it('does not auto-record when the bot check fails, but still prompts', async () => {
    // Fail-open is right for the prompt, not for recording: a scheduled bot
    // may already be recording the call.
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      checkActiveBot: async () => {
        throw new Error('network down');
      },
    });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', windowId: 'win-g', platform: 'zoom' },
      deps,
    );

    expect(calls.autoStarts).toHaveLength(0);
    expect(calls.upsert).toHaveLength(1);
    expect(calls.notify).toHaveLength(1);
  });

  it('does not auto-record a meeting that closed while the checks ran', async () => {
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      isStillActive: () => false,
    });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', windowId: 'win-h', platform: 'zoom' },
      deps,
    );

    expect(calls.autoStarts).toHaveLength(0);
  });

  it('re-checks that the meeting is still open after the alert, right before starting', async () => {
    let open = true;
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      notify: async () => {
        open = false; // meeting:closed landed while the alert was sent
      },
      isStillActive: () => open,
    });

    await handleMeetingDetected(
      { meetingUrl: 'recall-window:win-i', windowId: 'win-i', platform: 'slack' },
      deps,
    );

    expect(calls.autoStarts).toHaveLength(0);
  });

  it('starts recording a URL-carrying meeting that no bot covers', async () => {
    const { deps, calls } = makeDeps({ autoRecordEnabled: async () => true });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', windowId: 'win-c', platform: 'zoom' },
      deps,
    );

    expect(calls.autoStarts).toEqual(['win-c']);
  });

  it('never auto-records a meeting an active bot already covers', async () => {
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      checkActiveBot: async () => true,
    });

    await handleMeetingDetected(
      { meetingUrl: 'https://zoom.us/j/123', windowId: 'win-d', platform: 'zoom' },
      deps,
    );

    expect(calls.autoStarts).toHaveLength(0);
  });

  it('does not auto-record when the detection has no SDK window handle', async () => {
    // Without a windowId the only key is the meeting URL, which the recorder
    // cannot address — `start_recording` needs the SDK window handle.
    const { deps, calls } = makeDeps({ autoRecordEnabled: async () => true });

    await handleMeetingDetected({ meetingUrl: 'https://zoom.us/j/123', platform: 'zoom' }, deps);

    expect(calls.autoStarts).toHaveLength(0);
    expect(calls.notify).toHaveLength(1);
  });

  it('extracts the window handle from a synthetic URL for auto-record', async () => {
    const { deps, calls } = makeDeps({ autoRecordEnabled: async () => true });

    await handleMeetingDetected({ meetingUrl: 'recall-window:legacy-1', platform: 'slack' }, deps);

    expect(calls.autoStarts).toEqual(['legacy-1']);
  });

  it('fails closed (no recording) and still notifies when the setting read throws', async () => {
    const warnings: unknown[] = [];
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => {
        throw new Error('settings unreadable');
      },
      warn: (_msg, err) => warnings.push(err),
    });

    await handleMeetingDetected(
      { meetingUrl: 'recall-window:win-e', windowId: 'win-e', platform: 'slack' },
      deps,
    );

    expect(calls.autoStarts).toHaveLength(0);
    expect(calls.notify).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('still notifies and logs when the auto-start itself fails', async () => {
    const warnings: unknown[] = [];
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      startRecording: async () => {
        throw new Error('bridge not running');
      },
      warn: (_msg, err) => warnings.push(err),
    });

    await handleMeetingDetected(
      { meetingUrl: 'recall-window:win-f', windowId: 'win-f', platform: 'teams' },
      deps,
    );

    expect(calls.notify).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});

describe('replayRetainedDetections', () => {
  it('runs every retained detection through the detection handler', async () => {
    const { deps, calls } = makeDeps({ autoRecordEnabled: async () => true });

    await replayRetainedDetections(
      [
        { meetingUrl: 'recall-window:r1', windowId: 'r1', platform: 'slack' },
        { meetingUrl: 'https://zoom.us/j/9', windowId: 'r2', platform: 'zoom' },
      ],
      new Set(),
      deps,
    );

    expect(calls.upsert.map((s) => s.windowId)).toEqual(['r1', 'r2']);
    expect(calls.autoStarts).toEqual(['r1', 'r2']);
  });

  it('skips retained detections that are already recording', async () => {
    // A webview reload mid-recording must not re-seed the row as `detected`
    // or dispatch a second start the recorder never confirms.
    const { deps, calls } = makeDeps({ autoRecordEnabled: async () => true });

    await replayRetainedDetections(
      [
        { meetingUrl: 'recall-window:live', windowId: 'live', platform: 'zoom' },
        { meetingUrl: 'recall-window:new', windowId: 'new', platform: 'zoom' },
      ],
      new Set(['live']),
      deps,
    );

    expect(calls.upsert.map((s) => s.windowId)).toEqual(['new']);
    expect(calls.autoStarts).toEqual(['new']);
  });

  it('keeps going when one detection fails', async () => {
    const warnings: unknown[] = [];
    const { deps, calls } = makeDeps({
      autoRecordEnabled: async () => true,
      upsertRow: (seed) => {
        if (seed.windowId === 'bad') throw new Error('boom');
        calls.upsert.push(seed);
      },
      warn: (_msg, err) => warnings.push(err),
    });

    await replayRetainedDetections(
      [
        { meetingUrl: 'recall-window:bad', windowId: 'bad', platform: 'zoom' },
        { meetingUrl: 'recall-window:good', windowId: 'good', platform: 'zoom' },
      ],
      new Set(),
      deps,
    );

    expect(calls.autoStarts).toEqual(['good']);
    expect(warnings).toHaveLength(1);
  });
});

describe('startIsNoOp', () => {
  it('treats a Record click on an already-recording meeting as a no-op', () => {
    // After auto-record starts, the alert still offers Record. A second start
    // never gets a new `recording:started`, so it would time out after 45 s
    // and flip the live recording row to an error.
    expect(startIsNoOp('recording')).toBe(true);
  });

  it.each(['detected', 'starting', 'stopping', 'error', undefined])(
    'lets a start proceed from %s',
    (state) => {
      expect(startIsNoOp(state)).toBe(false);
    },
  );
});

describe('resolveWindowId', () => {
  it('prefers the explicit windowId field', () => {
    expect(resolveWindowId({ windowId: 'direct', meetingUrl: 'https://zoom.us/j/1' })).toEqual({
      windowId: 'direct',
      isSyntheticUrl: false,
    });
  });

  it('extracts the windowId from a synthetic recall-window URL', () => {
    expect(resolveWindowId({ meetingUrl: 'recall-window:xyz' })).toEqual({
      windowId: 'xyz',
      isSyntheticUrl: true,
    });
  });

  it('falls back to the meetingUrl as the dedup key for real URLs', () => {
    expect(resolveWindowId({ meetingUrl: 'https://zoom.us/j/1' })).toEqual({
      windowId: 'https://zoom.us/j/1',
      isSyntheticUrl: false,
    });
  });

  it('yields an empty windowId when nothing identifies the window', () => {
    expect(resolveWindowId({})).toEqual({ windowId: '', isSyntheticUrl: false });
  });
});
