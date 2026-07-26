// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { flushSync, mount, unmount } from 'svelte';
import V4TitleBar from '../../src/desktop-alt/v4/V4TitleBar.svelte';
import { LatestRequestCoordinator } from '../../src/desktop-alt/lib/latest-request';

type RefreshState = {
  value: string | null;
  error: string | null;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function refreshHarness() {
  const coordinator = new LatestRequestCoordinator();
  let state: RefreshState = { value: null, error: null };
  let active = false;
  let ready = false;
  const activeTransitions: boolean[] = [];

  const refresh = (request: Promise<string>) =>
    coordinator.run(
      async (isLatest) => {
        try {
          const value = await request;
          if (isLatest()) state = { value, error: null };
        } catch (error) {
          if (isLatest()) {
            state = { value: null, error: String(error) };
          }
        }
      },
      (nextActive) => {
        active = nextActive;
        if (!nextActive) ready = true;
        activeTransitions.push(nextActive);
      },
    );

  return {
    refresh,
    state: () => state,
    active: () => active,
    ready: () => ready,
    activeTransitions,
  };
}

describe('Desktop hydration latest-request coordination', () => {
  it('ignores an older failure that settles after a newer success', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const harness = refreshHarness();

    const olderRun = harness.refresh(older.promise);
    const newerRun = harness.refresh(newer.promise);
    expect(harness.active()).toBe(true);

    newer.resolve('new workspace state');
    await newerRun;
    expect(harness.state()).toEqual({
      value: 'new workspace state',
      error: null,
    });
    expect(harness.active()).toBe(false);

    older.reject(new Error('stale offline failure'));
    await olderRun;
    expect(harness.state()).toEqual({
      value: 'new workspace state',
      error: null,
    });
    expect(harness.active()).toBe(false);
  });

  it('ignores an older success that settles after a newer failure', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const harness = refreshHarness();

    const olderRun = harness.refresh(older.promise);
    const newerRun = harness.refresh(newer.promise);

    newer.reject(new Error('newest request failed'));
    await newerRun;
    expect(harness.state()).toEqual({
      value: null,
      error: 'Error: newest request failed',
    });
    expect(harness.active()).toBe(false);

    older.resolve('stale workspace state');
    await olderRun;
    expect(harness.state()).toEqual({
      value: null,
      error: 'Error: newest request failed',
    });
    expect(harness.active()).toBe(false);
  });

  it('keeps the newest request active when an older success or failure settles first', async () => {
    for (const olderOutcome of ['success', 'failure'] as const) {
      const older = deferred<string>();
      const newer = deferred<string>();
      const harness = refreshHarness();

      const olderRun = harness.refresh(older.promise);
      const newerRun = harness.refresh(newer.promise);

      if (olderOutcome === 'success') {
        older.resolve('stale workspace state');
      } else {
        older.reject(new Error('stale offline failure'));
      }
      await olderRun;

      expect(harness.state()).toEqual({ value: null, error: null });
      expect(harness.active()).toBe(true);
      expect(harness.ready()).toBe(false);
      expect(harness.activeTransitions).toEqual([true, true]);

      newer.resolve(`newest state after older ${olderOutcome}`);
      await newerRun;
      expect(harness.state()).toEqual({
        value: `newest state after older ${olderOutcome}`,
        error: null,
      });
      expect(harness.active()).toBe(false);
      expect(harness.ready()).toBe(true);
      expect(harness.activeTransitions).toEqual([true, true, false]);
    }
  });

  it('wires every DesktopApp hydrator through the coordinator generation', () => {
    const app = readFileSync(
      resolve(process.cwd(), 'src/desktop-alt/DesktopApp.svelte'),
      'utf8',
    );

    expect(app).toContain(
      "import { LatestRequestCoordinator, type LatestRequestCheck } from './lib/latest-request'",
    );
    expect(app).toContain('const refreshCoordinator = new LatestRequestCoordinator()');
    expect(app).toContain('refreshCoordinator.run(');
    for (const loader of [
      'loadWorkspaces',
      'loadSyncStatus',
      'loadDaemonStatus',
      'loadActivity',
      'loadHomeProjects',
    ]) {
      expect(app).toContain(
        `async function ${loader}(isLatest: LatestRequestCheck)`,
      );
    }
    expect(app).toContain('hydrationRefreshing={refreshingRealState}');
    expect(app).toMatch(
      /\(active\) => \{\s*refreshingRealState = active;\s*if \(!active\) ready = true;\s*\}/,
    );
    expect(app).toContain('void refreshRealState();');
    expect(app).not.toMatch(
      /void refreshRealState\(\)\.finally\([\s\S]*?ready = true;[\s\S]*?\);/,
    );
    expect(app).toMatch(
      /const nextWorkspaces = Array\.isArray\(result\?\.workspaces\)/,
    );
    expect(app).toMatch(
      /const nextActivity = Array\.isArray\(activityResponse\)/,
    );
  });
});

describe('rendered hydration Retry state', () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
    vi.clearAllMocks();
  });

  it('disables Retry while the newest hydration request is active', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const onretryhydration = vi.fn();
    component = mount(V4TitleBar, {
      target: host,
      props: {
        version: '0.10.33',
        syncState: 'idle',
        watchedCount: 4,
        hydrationIssue: {
          kind: 'sync-status',
          detail: 'Could not read the latest sync status',
        },
        hydrationRefreshing: true,
        onretryhydration,
      },
    });
    flushSync();

    const retry = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    expect(retry).toBeTruthy();
    expect(retry?.disabled).toBe(true);
    retry?.click();
    expect(onretryhydration).not.toHaveBeenCalled();
  });
});
