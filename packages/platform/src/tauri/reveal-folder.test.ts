import { describe, expect, it, vi } from "vitest";
import { TauriPlatformAdapter } from "./index";

// Regression: `revealInFinder` invoked a command named `reveal_in_finder`,
// which has NEVER existed in the Rust invoke_handler — the only registered
// reveal command is `commands::launch::reveal_folder` (apps/sync/src-tauri/
// src/main.rs). Every call therefore rejected with "Command reveal_in_finder
// not found", so the title-bar "Open HQ folder" button and FilePreviewPane's
// "Reveal in Finder" both silently did nothing. Lock the wire name here.

describe("TauriPlatformAdapter files.revealInFinder", () => {
  it("invokes the registered `reveal_folder` command with the path", async () => {
    const invoke = vi.fn(async () => undefined);
    const adapter = new TauriPlatformAdapter({ invoke } as never);

    const res = await adapter.files.revealInFinder("/Users/x/Documents/HQ");

    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("reveal_folder", {
      path: "/Users/x/Documents/HQ",
    });
  });

  it("never invokes the non-existent `reveal_in_finder` command", async () => {
    const invoke = vi.fn(async () => undefined);
    const adapter = new TauriPlatformAdapter({ invoke } as never);

    await adapter.files.revealInFinder("/Users/x/Documents/HQ");

    const names = invoke.mock.calls.map((c) => (c as unknown as string[])[0]);
    expect(names).not.toContain("reveal_in_finder");
  });

  it("surfaces an invoke rejection instead of resolving ok", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Command reveal_folder not found");
    });
    const adapter = new TauriPlatformAdapter({ invoke } as never);

    const res = await adapter.files.revealInFinder("/Users/x/Documents/HQ");

    expect(res.ok).toBe(false);
  });
});
