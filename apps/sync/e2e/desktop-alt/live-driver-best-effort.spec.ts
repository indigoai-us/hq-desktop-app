import { describe, expect, it } from 'vitest';

import {
  bestEffort,
  formatRecentBestEffortFailures,
  getBestEffortFailures,
  LiveDesktopAltHarness,
} from './live-driver';

describe('desktop-alt best-effort driver probes', () => {
  it('returns a rejecting promise fallback and records a sanitized first-line failure', async () => {
    const fallback = await bestEffort(
      Promise.reject(new Error('first line Bearer hidden-token https://driver.test/path?token=hidden-query\nsecond line')),
      'fallback-value',
      'unit rejecting probe',
    );

    expect(fallback).toBe('fallback-value');
    expect(getBestEffortFailures().entries.at(-1)).toEqual({
      label: 'unit rejecting probe',
      errorName: 'Error',
      firstLine: 'first line Bearer [REDACTED] [URL]',
    });
    expect(formatRecentBestEffortFailures()).not.toContain('hidden-token');
    expect(formatRecentBestEffortFailures()).not.toContain('hidden-query');
  });

  it('redacts whole quoted credential values that contain whitespace', async () => {
    await bestEffort(
      Promise.reject(new Error('probe failed password="top secret value" api_key=\'two words\' token: "unterminated tail')),
      null,
      'unit quoted secret probe',
    );

    expect(getBestEffortFailures().entries.at(-1)?.firstLine).toBe(
      'probe failed password=[REDACTED] api_key=[REDACTED] token: [REDACTED]',
    );
    const report = formatRecentBestEffortFailures();
    expect(report).not.toContain('secret value');
    expect(report).not.toContain('two words');
    expect(report).not.toContain('unterminated tail');
  });

  it('returns a resolving promise value without recording a failure', async () => {
    const before = getBestEffortFailures();
    const value = await bestEffort(Promise.resolve('resolved-value'), 'fallback-value', 'unit resolving probe');
    const after = getBestEffortFailures();

    expect(value).toBe('resolved-value');
    expect(after.total).toBe(before.total);
    expect(after.entries).toEqual(before.entries);
  });

  it('keeps at most 50 failure entries and reports the omitted count', async () => {
    const before = getBestEffortFailures();
    for (let index = 0; index < 55; index += 1) {
      await bestEffort(Promise.reject(new Error(`failure-${index}`)), undefined, `cap probe ${index}`);
    }
    const after = getBestEffortFailures();
    const report = formatRecentBestEffortFailures();

    expect(after.entries).toHaveLength(50);
    expect(after.total).toBe(before.total + 55);
    expect(after.dropped).toBe(after.total - 50);
    expect(report).toContain('10 shown of');
    expect(report).toContain(`${after.total - 10} omitted`);
    expect(report).toContain(`${after.dropped} evicted`);
    expect(after.entries.at(-1)?.label).toBe('cap probe 54');
  });

  it('includes recent best-effort failures in the main-window readiness diagnostic', async () => {
    const driver = {
      async waitForWindow() {},
      async getWindowHandles() { return ['webview-a']; },
      async switchToWindow() {},
      async execute<T>() { return true as T; },
      async waitUntil() { throw new Error('main-window predicate timeout first line\nignored detail'); },
    };
    const harness = await LiveDesktopAltHarness.create(
      driver as never,
      { appPath: 'C:/fake/hq-sync-menubar.exe', webdriverUrl: 'http://127.0.0.1:4444' } as never,
    );

    await expect(harness.switchToMainWindow()).rejects.toThrow(
      /switchToMainWindow readiness wait \[Error\]: main-window predicate timeout first line/,
    );
  });
});
