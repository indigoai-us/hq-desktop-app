import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Settings → Bots (Work shell, local-bots US-009)", () => {
  it("is a first-class ShellSettings nav item on desktop, right after AI tools", () => {
    const shell = readFileSync(
      fileURLToPath(new URL("./ShellSettings.svelte", import.meta.url)),
      "utf8",
    );
    expect(shell).toContain('{ id: "bots", label: "Bots" }');
    expect(shell.indexOf('{ id: "bots"')).toBeGreaterThan(shell.indexOf('{ id: "agents"'));
    expect(shell).toContain("BotsSettingsPane");
    expect(shell).toContain('if (section.id === "bots") return Boolean(adapter?.bots);');
  });

  it("drives every action through the adapter's desktop-only bots group", () => {
    const pane = readFileSync(
      fileURLToPath(new URL("./BotsSettingsPane.svelte", import.meta.url)),
      "utf8",
    );
    for (const call of ["api.list()", "api.create({ name, runtime: newRuntime })", "api[verb](name)"]) {
      expect(pane).toContain(call);
    }
    expect(pane).not.toContain("@tauri-apps");
    expect(pane).not.toContain("fetch(");
  });
});
