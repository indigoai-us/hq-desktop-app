// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type CompanyApi } from "@hq/platform";

import {
  companyStore,
  configureCompanyApi,
  isCompanyResourceUnavailable,
  stopCompanyStore,
} from "./company-store.svelte";
import {
  ACTIVITY_REQUEST_TIMEOUT_MS,
  ActivityRequestTimeoutError,
} from "../common/activity-request";

const getActivity = vi.fn();

beforeEach(() => {
  stopCompanyStore();
  getActivity.mockReset();
  configureCompanyApi({ getActivity } as unknown as CompanyApi);
});

afterEach(() => {
  stopCompanyStore();
  configureCompanyApi(null);
  vi.useRealTimers();
});

describe("companyStore Activity request lifecycle", () => {
  it("evicts a timed-out cached request so Retry starts a fresh backend call", async () => {
    vi.useFakeTimers();
    getActivity
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(ok({ stats: { files7: 2 } }));

    const first = companyStore.loadActivity("indigo");
    const rejection = expect(first).rejects.toBeInstanceOf(
      ActivityRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(ACTIVITY_REQUEST_TIMEOUT_MS);
    await rejection;

    await expect(companyStore.loadActivity("indigo", true)).resolves.toEqual({
      stats: { files7: 2 },
    });
    expect(getActivity).toHaveBeenCalledTimes(2);
    expect(getActivity).toHaveBeenNthCalledWith(1, "indigo");
    expect(getActivity).toHaveBeenNthCalledWith(2, "indigo");
  });

  it("surfaces `unavailable` results as CompanyResourceUnavailableError (degraded state, not crash)", async () => {
    getActivity.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "not-yet-implemented-api",
    });

    await expect(companyStore.loadActivity("indigo")).rejects.toSatisfy(
      (err: unknown) => isCompanyResourceUnavailable(err),
    );
  });
});
