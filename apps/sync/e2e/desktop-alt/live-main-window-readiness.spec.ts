import { describe, expect, it } from 'vitest';

import { LiveDesktopAltHarness } from './live-driver';

/**
 * Regression cover for the live pre-auth smoke's first step.
 *
 * `createLivePreAuthProbe` calls `switchToMainWindow()` as soon as the WebDriver
 * session exists. WebDriver exposes the popover's browser target the moment
 * WebView2 creates it, which is strictly before `src/main.ts` runs and stamps
 * `document.documentElement.dataset.window = 'main'`. Sampling that predicate
 * once therefore raced the app's first paint: on run 31221474416 msedgedriver
 * reported exactly one page at `http://tauri.localhost/` whose document was
 * still empty, ~1.7s after launch, and the probe failed with "the app exposed 1
 * webview(s) ... but none of them is the classic popover".
 *
 * The race only reproduces on a real Windows runner, so it is pinned here
 * against a fake driver instead: the harness must poll the predicate to a
 * deadline, and must still fail when the popover genuinely never appears.
 */

type ExecuteScript = string;

interface FakeDriverOptions {
  /** Handles the app exposes, in the order WebDriver reports them. */
  handles: string[];
  /** The handle that eventually identifies itself as the classic popover. */
  popover: string | null;
  /** Polls of the popover predicate that answer `false` before it flips true. */
  pollsBeforeReady: number;
}

interface FakeDriver {
  waitForWindow(): Promise<void>;
  getWindowHandles(): Promise<string[]>;
  switchToWindow(handle: string): Promise<void>;
  execute<T>(script: ExecuteScript): Promise<T>;
  waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void>;
  /** Every timeout the harness asked `waitUntil` to honour. */
  readonly requestedTimeouts: number[];
  /** The handle the harness ultimately switched to. */
  readonly currentHandle: string | null;
  readonly popoverPredicateCalls: number;
}

const MAIN_WINDOW_PREDICATE_MARKER = "dataset?.window === 'main'";
// The fake polls far faster than the real driver so the suite stays inside the
// scripted 5s test timeout. What is under test is that the harness delegates to
// a bounded wait at all, and with a real deadline — not the wall-clock value.
const FAKE_POLL_INTERVAL_MS = 5;
const FAKE_POLL_CEILING_MS = 500;

function createFakeDriver(options: FakeDriverOptions): FakeDriver {
  const requestedTimeouts: number[] = [];
  let currentHandle: string | null = null;
  let popoverPredicateCalls = 0;

  return {
    requestedTimeouts,
    get currentHandle() {
      return currentHandle;
    },
    get popoverPredicateCalls() {
      return popoverPredicateCalls;
    },
    async waitForWindow() {},
    async getWindowHandles() {
      return [...options.handles];
    },
    async switchToWindow(handle: string) {
      currentHandle = handle;
    },
    async execute<T>(script: ExecuteScript): Promise<T> {
      if (!script.includes(MAIN_WINDOW_PREDICATE_MARKER)) {
        // The error-capture bootstrap and friends; not under test here.
        return true as T;
      }
      popoverPredicateCalls += 1;
      const ready = popoverPredicateCalls > options.pollsBeforeReady * options.handles.length;
      return (ready && currentHandle === options.popover) as T;
    },
    async waitUntil(predicate: () => Promise<boolean>, timeoutMs: number) {
      requestedTimeouts.push(timeoutMs);
      const deadline = Date.now() + Math.min(timeoutMs, FAKE_POLL_CEILING_MS);
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, FAKE_POLL_INTERVAL_MS));
      }
      throw new Error('Timed out waiting for WebDriver condition.');
    },
  };
}

async function harnessFor(options: FakeDriverOptions) {
  const driver = createFakeDriver(options);
  const harness = await LiveDesktopAltHarness.create(
    driver as never,
    { appPath: 'C:/fake/hq-sync-menubar.exe', webdriverUrl: 'http://127.0.0.1:4444' } as never,
  );
  return { driver, harness };
}

describe('live pre-auth probe: classic popover readiness', () => {
  it('waits for the popover to stamp itself instead of sampling once', async () => {
    // Two polling rounds answer "not yet" — exactly the shape of the observed
    // failure, where the page existed but had not run `src/main.ts`.
    const { driver, harness } = await harnessFor({
      handles: ['webview-a', 'webview-b'],
      popover: 'webview-b',
      pollsBeforeReady: 2,
    });

    await expect(harness.switchToMainWindow()).resolves.toBeUndefined();
    expect(driver.currentHandle).toBe('webview-b');
    // A single-shot lookup would have given up on the first round.
    expect(driver.popoverPredicateCalls).toBeGreaterThan(2);
  });

  it('asks for a deadline long enough to cover a cold Windows first paint', async () => {
    const { driver, harness } = await harnessFor({
      handles: ['webview-a'],
      popover: 'webview-a',
      pollsBeforeReady: 1,
    });

    await harness.switchToMainWindow();
    expect(driver.requestedTimeouts).toHaveLength(1);
    // Not a token wait: the app alone takes ~5s to first paint on a runner.
    expect(driver.requestedTimeouts[0]).toBeGreaterThanOrEqual(10_000);
  });

  it('still fails, and names the deadline, when no popover ever appears', async () => {
    const { harness } = await harnessFor({
      handles: ['webview-a'],
      popover: null,
      pollsBeforeReady: 0,
    });

    await expect(harness.switchToMainWindow()).rejects.toThrow(
      /exposed 1 webview\(s\).*classic popover \(html\[data-window="main"\]\) within \d+ms/s,
    );
  });
});
