import { describe, expect, it, vi } from "vitest";

vi.mock("@hq/core", () => ({
  LiveReadStore: class {},
  MeshClient: class {},
  PresenceStore: class {},
  createWebCredentialProvider: () => ({}),
}));

vi.mock("@hq/ui", () => ({
  bindLiveReadStore: () => () => {},
  bindLiveRefresh: () => () => {},
  bindPresenceStore: () => () => {},
  createChatWakeBus: () => ({}),
  routeMeshReconcile: () => "none",
  routeMeshWake: () => {},
  wirePresenceStoreToChatBus: () => () => {},
}));

import { createHqReconcileFetcher } from "./mesh-runtime.js";

describe("createHqReconcileFetcher", () => {
  it("logs a non-JSON body and still returns null state", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.reject(new SyntaxError("Unexpected token secret-body")),
        } as unknown as Response;
      });
      const fetchState = createHqReconcileFetcher(
        fetchImpl as unknown as typeof fetch,
      );
      await expect(
        fetchState({ path: "/v1/notify/notifications" }),
      ).resolves.toEqual({ state: null, cursor: undefined });
      expect(debug).toHaveBeenCalledWith(
        "mesh-runtime: reconcile body was not JSON",
        "SyntaxError",
      );
      expect(JSON.stringify(debug.mock.calls)).not.toContain("secret-body");

      const httpFail = vi.fn(async () => {
        return { ok: false, status: 500 } as Response;
      });
      await expect(
        createHqReconcileFetcher(httpFail as unknown as typeof fetch)({
          path: "/v1/notify/notifications",
        }),
      ).rejects.toThrow("reconcile /v1/notify/notifications failed (500)");
    } finally {
      debug.mockRestore();
    }
  });
});
