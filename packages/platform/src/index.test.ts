import { describe, expect, it } from "vitest";
import { createMemoryAdapter } from "./index.js";

describe("createMemoryAdapter", () => {
  it("round-trips settings", async () => {
    const adapter = createMemoryAdapter("desktop");
    expect(adapter.kind).toBe("desktop");
    expect(await adapter.getSetting("theme")).toBeNull();
    await adapter.setSetting("theme", "dark");
    expect(await adapter.getSetting("theme")).toBe("dark");
  });
});
