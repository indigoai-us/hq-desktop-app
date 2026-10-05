// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type CompanyApi } from "@hq/platform";

import {
  companyStore,
  configureCompanyApi,
  isCompanyResourceUnavailable,
  setActiveCompanyResource,
  startCompanyStore,
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

  it("logs a failed focus refresh and still accepts the next load", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const getSecrets = vi.fn(async () => {
      throw new Error("secrets down");
    });
    configureCompanyApi({ getActivity, getSecrets } as unknown as CompanyApi);
    try {
      setActiveCompanyResource("indigo", "secrets");
      startCompanyStore();
      window.dispatchEvent(new Event("focus"));
      await vi.waitFor(() =>
        expect(debug).toHaveBeenCalledWith("company-store: refresh failed", "secrets down"),
      );
      getSecrets.mockResolvedValueOnce(ok([]));
      await expect(companyStore.loadSecrets("indigo", true)).resolves.toEqual([]);
    } finally {
      debug.mockRestore();
    }
  });
});
