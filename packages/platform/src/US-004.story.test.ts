/**
 * US-004 acceptance test (from PRD e2eTests):
 * Given the web adapter, when a screen requests a desktop-only capability,
 * then the unavailable state renders instead of an error.
 */
import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./web/index.js";

const neverFetch: typeof globalThis.fetch = async () => {
  throw new Error("desktop-only paths must not hit the network");
};

describe("US-004: PlatformAdapter interface with capability flags and web/tauri implementations", () => {
  it("web adapter returns the unavailable state (not an error) for a desktop-only capability", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.example.test",
      fetch: neverFetch,
    });

    // Capability flag advertises unavailability up front.
    expect(adapter.capabilities.canSync).toBe(false);

    // A screen calling a desktop-only method gets the standard degraded
    // contract — a resolved unavailable result, never a rejection.
    const result = await adapter.sync.startDaemon();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unavailable");
      expect(result.code).toBe("desktop-only");
    }

    const reveal = await adapter.files.revealInFinder("companies/indigo");
    expect(reveal.ok).toBe(false);
    if (!reveal.ok) {
      expect(reveal.reason).toBe("unavailable");
    }

    expect(adapter.capabilities.localWorkMeshCache).toBe(false);
    const snapshot = await adapter.workMesh.readLocalSnapshot();
    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) {
      expect(snapshot.reason).toBe("unavailable");
      expect(snapshot.code).toBe("desktop-only");
    }
  });
});
