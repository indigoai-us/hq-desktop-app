import { afterEach, describe, expect, it, vi } from "vitest";

const { moduleFactory, moduleInvoke } = vi.hoisted(() => ({
  moduleFactory: vi.fn(),
  moduleInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => {
  moduleFactory();
  return { invoke: moduleInvoke };
});

import { tauriInvoke } from "./tauri-invoke.js";

afterEach(() => {
  vi.unstubAllGlobals();
  moduleInvoke.mockReset();
});

describe("tauri invoke boundary", () => {
  it("loads module invoke when no global Tauri bridge is present", async () => {
    vi.stubGlobal("window", {});
    moduleInvoke.mockResolvedValueOnce({ personUid: "prs_desktop" });

    await expect(tauriInvoke("whoami", { includeProfile: true })).resolves.toEqual({
      personUid: "prs_desktop",
    });

    expect(moduleInvoke).toHaveBeenCalledWith("whoami", {
      includeProfile: true,
    });
    expect(moduleFactory).toHaveBeenCalledTimes(1);
  });
});
