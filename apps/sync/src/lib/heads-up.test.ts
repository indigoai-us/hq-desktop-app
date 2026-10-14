import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HEADS_UP_COPY,
  HEADS_UP_REMIND_AT_KEY,
  HEADS_UP_REMINDER_DELAY_MS,
  MANUAL_SETUP_URL,
  runHeadsUpAction,
  startSessionScan,
  type HeadsUpActionDeps,
} from './heads-up';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

function deps(overrides: Partial<HeadsUpActionDeps> = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const storage = memoryStorage();
  const d = {
    startFlow: vi.fn(async () => {}),
    hideToTray: vi.fn(async () => {}),
    openUrl: vi.fn(async (_url: string) => {}),
    notify: vi.fn(async (_title: string, _body: string) => {}),
    bringToFront: vi.fn(async () => {}),
    storage,
    setTimer: (fn: () => void, ms: number) => void timers.push({ fn, ms }),
    now: () => 1_000,
    ...overrides,
  };
  return { d, timers, storage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('heads-up actions', () => {
  it('"Start now" goes to the existing flow and nothing else', async () => {
    const { d, timers } = deps();
    await runHeadsUpAction('start', d);
    expect(d.startFlow).toHaveBeenCalledTimes(1);
    expect(d.hideToTray).not.toHaveBeenCalled();
    expect(d.openUrl).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('"Do it later" saves and arms a reminder, then hides to the tray', async () => {
    const { d, timers, storage } = deps();
    await runHeadsUpAction('later', d);
    expect(storage.getItem(HEADS_UP_REMIND_AT_KEY)).toBe(String(1_000 + HEADS_UP_REMINDER_DELAY_MS));
    expect(timers).toEqual([{ fn: expect.any(Function), ms: HEADS_UP_REMINDER_DELAY_MS }]);
    expect(d.hideToTray).toHaveBeenCalledTimes(1);
    expect(d.startFlow).not.toHaveBeenCalled();

    timers[0].fn();
    await vi.waitFor(() => expect(d.bringToFront).toHaveBeenCalledTimes(1));
    expect(d.notify).toHaveBeenCalledWith(HEADS_UP_COPY.reminderTitle, HEADS_UP_COPY.reminderBody);
    expect(storage.getItem(HEADS_UP_REMIND_AT_KEY)).toBeNull();
  });

  it('a failed reminder notification is logged and the window still comes back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('denied');
    const { d, timers } = deps({ notify: vi.fn(async () => Promise.reject(error)) });
    await runHeadsUpAction('later', d);
    timers[0].fn();
    await vi.waitFor(() => expect(d.bringToFront).toHaveBeenCalledTimes(1));
    expect(logged).toHaveBeenCalledWith('heads-up: reminder notification failed', error);
  });

  it('"Manual setup" opens the hq.computer guide, then hides to the tray', async () => {
    const { d, timers } = deps();
    await runHeadsUpAction('manual', d);
    expect(d.openUrl).toHaveBeenCalledWith(MANUAL_SETUP_URL);
    expect(MANUAL_SETUP_URL.startsWith('https://hq.computer/')).toBe(true);
    expect(d.hideToTray).toHaveBeenCalledTimes(1);
    expect(d.startFlow).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('"Manual setup" logs a failed open and still hides to the tray', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('no browser');
    const { d } = deps({ openUrl: vi.fn(async () => Promise.reject(error)) });
    await runHeadsUpAction('manual', d);
    expect(logged).toHaveBeenCalledWith('heads-up: could not open the manual setup guide', error);
    expect(d.hideToTray).toHaveBeenCalledTimes(1);
  });

  it('logs a failed hide instead of dropping it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('no window');
    const { d } = deps({ hideToTray: vi.fn(async () => Promise.reject(error)) });
    await runHeadsUpAction('later', d);
    expect(logged).toHaveBeenCalledWith('heads-up: could not hide to the tray', error);
  });
});

describe('startSessionScan', () => {
  it('returns the parsed scan JSON', async () => {
    const invoke = vi.fn(async () => '{"sessions":[{"tool":"claude"}]}');
    await expect(startSessionScan(invoke as never)).resolves.toEqual({ sessions: [{ tool: 'claude' }] });
    expect(invoke).toHaveBeenCalledWith('scan_local_sessions');
  });

  it('passes through an already-parsed result', async () => {
    const invoke = vi.fn(async () => ({ sessions: [] }));
    await expect(startSessionScan(invoke as never)).resolves.toEqual({ sessions: [] });
  });

  it('warns and returns null when the command is missing from this build', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = vi.fn(async () => Promise.reject('Command scan_local_sessions not found'));
    await expect(startSessionScan(invoke as never)).resolves.toBeNull();
    expect(warned).toHaveBeenCalledWith(
      'heads-up: scan_local_sessions is not available in this build; skipping the scan',
      'Command scan_local_sessions not found',
    );
  });

  it('logs any other failure as an error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi.fn(async () => Promise.reject(new Error('disk read failed')));
    await expect(startSessionScan(invoke as never)).resolves.toBeNull();
    expect(logged).toHaveBeenCalledWith('heads-up: session scan failed', expect.any(Error));
  });

  it('is a no-op outside Tauri', async () => {
    await expect(startSessionScan(undefined)).resolves.toBeNull();
  });
});

describe('heads-up copy (source contract)', () => {
  const component = readFileSync(
    fileURLToPath(new URL('../components/onboarding/HeadsUpWindow.svelte', import.meta.url)),
    'utf8',
  );
  const allCopy = [
    HEADS_UP_COPY.title,
    ...HEADS_UP_COPY.points,
    HEADS_UP_COPY.startNow,
    HEADS_UP_COPY.later,
    HEADS_UP_COPY.manual,
    HEADS_UP_COPY.laterHint,
    HEADS_UP_COPY.reminderTitle,
    HEADS_UP_COPY.reminderBody,
  ].join('\n');

  it('covers the three points: setting up HQ, a few minutes, and the sign-in account', () => {
    expect(HEADS_UP_COPY.title).toBe('You are about to set up HQ');
    expect(allCopy).toMatch(/a few minutes/);
    expect(allCopy).toMatch(/Google or Microsoft/);
    expect(allCopy).toMatch(/If you were invited, sign in with the email the invite was sent to/);
  });

  it('labels the three actions', () => {
    expect([HEADS_UP_COPY.startNow, HEADS_UP_COPY.later, HEADS_UP_COPY.manual]).toEqual([
      'Start now',
      'Do it later',
      'Manual setup',
    ]);
    for (const id of ['heads-up-start', 'heads-up-later', 'heads-up-manual']) {
      expect(component).toContain(`data-testid="${id}"`);
    }
  });

  it('has no em or en dashes and no emoji', () => {
    for (const text of [allCopy, component]) {
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('keeps every font weight at 500 or below and draws no left accent bar', () => {
    const weights = [...component.matchAll(/font-weight:\s*(\d+)(?!\s+\d)/g)].map((m) => Number(m[1]));
    expect(weights.length).toBeGreaterThan(0);
    for (const weight of weights) expect(weight).toBeLessThanOrEqual(500);
    expect(component).not.toMatch(/font-weight:\s*(bold|bolder)/);
    expect(component).not.toMatch(/border-left/);
  });

  it('renders its copy from HEADS_UP_COPY rather than inline strings', () => {
    expect(component).toContain('HEADS_UP_COPY.title');
    expect(component).toContain('HEADS_UP_COPY.points');
    expect(component).not.toContain(HEADS_UP_COPY.title);
  });
});
