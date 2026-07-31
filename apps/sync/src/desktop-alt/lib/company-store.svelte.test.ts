// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  companyStore,
  stopCompanyStore,
} from './company-store.svelte';
import {
  ACTIVITY_REQUEST_TIMEOUT_MS,
  ActivityRequestTimeoutError,
} from './activity-request';

beforeEach(() => {
  stopCompanyStore();
  invoke.mockReset();
});

afterEach(() => {
  stopCompanyStore();
  vi.useRealTimers();
});

describe('companyStore Activity request lifecycle', () => {
  it('evicts a timed-out cached request so Retry starts a fresh backend call', async () => {
    vi.useFakeTimers();
    invoke
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce({ stats: { files7: 2 } });

    const first = companyStore.loadActivity('indigo');
    const rejection = expect(first).rejects.toBeInstanceOf(
      ActivityRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(ACTIVITY_REQUEST_TIMEOUT_MS);
    await rejection;

    await expect(companyStore.loadActivity('indigo', true)).resolves.toEqual({
      stats: { files7: 2 },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'get_company_activity', {
      slug: 'indigo',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'get_company_activity', {
      slug: 'indigo',
    });
  });
});
