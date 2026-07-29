// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  activity: vi.fn(),
  loadActivity: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../lib/company-store.svelte', () => ({
  companyStore: {
    revision: 0,
    activity: mocks.activity,
    loadActivity: mocks.loadActivity,
  },
}));

import { flushSync, mount, unmount } from 'svelte';
import { ActivityRequestTimeoutError } from '../lib/activity-request';
import ActivityPanel from './ActivityPanel.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  mocks.invoke.mockReset().mockResolvedValue({ hqFolderPath: '' });
  mocks.activity.mockReset().mockReturnValue(null);
  mocks.loadActivity.mockReset();
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ActivityPanel loading failures', () => {
  it('ends skeleton loading on a backend rejection and offers a working retry', async () => {
    mocks.loadActivity
      .mockRejectedValueOnce(new Error('GET /activity returned 503'))
      .mockResolvedValueOnce({ stats: {}, sparkline: [], recent: [], top: [] });

    component = mount(ActivityPanel, {
      target: host,
      props: { slug: 'indigo', cloudBacked: true, syncEnabled: true },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Activity unavailable');
    });

    expect(host.textContent).toContain('Couldn’t load activity');
    expect(host.textContent).not.toContain('GET /activity returned 503');
    expect(host.querySelector('[aria-label="Loading edits over time"]')).toBeNull();

    const retry = host.querySelector<HTMLButtonElement>('.activity-error button');
    expect(retry?.textContent).toContain('Retry');
    retry?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(mocks.loadActivity).toHaveBeenCalledTimes(2);
      expect(host.textContent).not.toContain('Activity unavailable');
      expect(host.textContent).not.toContain('Loading activity');
      expect(host.textContent).toContain('No activity yet');
    });
  });

  it('turns the store deadline rejection into a retryable timeout state', async () => {
    mocks.loadActivity.mockRejectedValue(new ActivityRequestTimeoutError());

    component = mount(ActivityPanel, {
      target: host,
      props: { slug: 'indigo', cloudBacked: true, syncEnabled: true },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Activity unavailable');
    });

    expect(host.textContent).toContain('Activity unavailable');
    expect(host.textContent).toContain('took too long');
    expect(host.textContent).toContain('Refresh failed');
    expect(host.querySelector('[aria-label="Loading edits over time"]')).toBeNull();
  });
});
