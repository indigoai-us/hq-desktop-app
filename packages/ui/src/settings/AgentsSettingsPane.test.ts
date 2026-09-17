import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Settings → AI tools (Work shell)", () => {
  it("is a first-class ShellSettings nav item on desktop", () => {
    const shell = readFileSync(
      fileURLToPath(new URL("./ShellSettings.svelte", import.meta.url)),
      "utf8",
    );
    expect(shell).toContain('{ id: "agents", label: "AI tools" }');
    expect(shell).toContain("AgentsSettingsPane");
    expect(shell).toContain("adapter?.sessions?.preflight");
  });
});
