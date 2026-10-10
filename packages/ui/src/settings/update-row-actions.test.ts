import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUIET_INSTALL_ATTEMPTS,
  RESTART_HQ_LABEL,
  TRY_AGAIN_LABEL,
  UPDATE_HEAL_PROMPT,
  UPDATE_NOW_LABEL,
  UPDATING_LABEL,
  desktopButtonLabel,
  quietInstall,
  rowButtonLabel,
} from "./update-row-actions";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quietInstall", () => {
  it("returns true on the first success", async () => {
    const run = vi.fn(async () => ({ ok: true as const }));
    await expect(quietInstall(run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries quietly and succeeds on a later attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "npm ERR! 502 {\"error\":\"boom\"}" })
      .mockResolvedValueOnce({ ok: false, message: "HTTP 500" })
      .mockResolvedValueOnce({ ok: true });
    await expect(quietInstall(run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(QUIET_INSTALL_ATTEMPTS);
    expect(warn).toHaveBeenCalled();
  });

  it("returns false after every attempt fails and does not throw the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => ({
      ok: false as const,
      message: "invoke install_hq_cli_update HTTP 502",
    }));
    await expect(quietInstall(run)).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(QUIET_INSTALL_ATTEMPTS);
    expect(warn.mock.calls.join(" ")).toContain("install_hq_cli_update");
  });
});

describe("row labels", () => {
  it("uses Update now, Updating…, Try again, and Restart HQ", () => {
    expect(rowButtonLabel("idle", true)).toBe(UPDATE_NOW_LABEL);
    expect(rowButtonLabel("updating", true)).toBe(UPDATING_LABEL);
    expect(rowButtonLabel("failed", true)).toBe(TRY_AGAIN_LABEL);
    expect(rowButtonLabel("idle", false)).toBeNull();
    expect(
      desktopButtonLabel({
        busy: false,
        showDownload: false,
        showRestart: true,
        failed: false,
      }),
    ).toBe(RESTART_HQ_LABEL);
    expect(UPDATE_HEAL_PROMPT).toBe(
      "HQ couldn't update itself. Find out why and get it up to date.",
    );
  });
});
