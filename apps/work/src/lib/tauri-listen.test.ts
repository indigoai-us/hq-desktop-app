import { afterEach, describe, expect, it, vi } from "vitest";

const { moduleFactory, moduleListen } = vi.hoisted(() => ({
  moduleFactory: vi.fn(),
  moduleListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => {
  moduleFactory();
  return { listen: moduleListen };
});

import { tauriListen } from "./tauri-listen.js";

afterEach(() => {
  vi.unstubAllGlobals();
  moduleListen.mockReset();
});

describe("tauri event boundary", () => {
  it("loads module listen when no global Tauri bridge is present", async () => {
    vi.stubGlobal("window", {});
    const handler = vi.fn();
    const unlisten = vi.fn();
    moduleListen.mockResolvedValueOnce(unlisten);

    await expect(tauriListen("auth:session-changed", handler)).resolves.toBe(
      unlisten,
    );

    expect(moduleListen).toHaveBeenCalledWith("auth:session-changed", handler);
    expect(moduleFactory).toHaveBeenCalledTimes(1);
  });
});
