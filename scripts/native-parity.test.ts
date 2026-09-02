import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const parity = join(repo, "apps/native-macos/Parity");

describe("native macOS parity gate", () => {
  it("accepts the generated parity ledger", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-native-parity.mjs"], {
        cwd: repo,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("maps every registered command without frontend-only drift", () => {
    const ledger = JSON.parse(readFileSync(join(parity, "commands.json"), "utf8"));
    expect(ledger.registeredCount).toBe(278);
    expect(ledger.commands).toHaveLength(ledger.registeredCount);
    expect(ledger.frontendOnlyCommands).toEqual([]);
    expect(
      ledger.commands.every((command: { disposition: string }) =>
        ["engine", "native", "retired", "windows-only"].includes(command.disposition),
      ),
    ).toBe(true);
    expect(
      ledger.commands
        .filter((command: { name: string }) =>
          [
            "begin_reauth",
            "set_workspace_sync_enabled",
            "take_pending_messages_target",
          ].includes(command.name),
        )
        .map((command: { name: string }) => command.name)
        .sort(),
    ).toEqual([
      "begin_reauth",
      "set_workspace_sync_enabled",
      "take_pending_messages_target",
    ]);
  });

  it("retains the audited auth event without a remote Git dependency", () => {
    const ledger = JSON.parse(readFileSync(join(parity, "events.json"), "utf8"));
    expect(ledger.listenerCount).toBe(70);
    expect(ledger.events).toHaveLength(ledger.listenerCount);
    expect(
      ledger.events.filter(
        (event: { disposition: string }) => event.disposition === "engine",
      ),
    ).toHaveLength(46);
    expect(
      ledger.events.filter(
        (event: { disposition: string }) => event.disposition === "native",
      ),
    ).toHaveLength(23);
    expect(
      ledger.events.some(
        (event: { name: string; disposition: string }) =>
          event.name === "auth:reauth-required" &&
          event.disposition === "engine",
        ),
    ).toBe(true);
    expect(
      ledger.events.find(
        (event: { name: string }) => event.name === "sync:conflict",
      ),
    ).toMatchObject({
      disposition: "retired",
      nativeReplacement: expect.stringContaining("sync:complete"),
    });
  });

  it("records exact Swift ownership for the final AppKit command set", () => {
    const ledger = JSON.parse(readFileSync(join(parity, "commands.json"), "utf8"));
    const finalNativeCommands = [
      "meetings_clear_prompt_badge",
      "meetings_take_pending_focus",
      "open_in_editor",
      "pick_avatar_file",
      "pick_pack_directory",
      "set_main_window_vibrancy",
      "show_main_window_at_tray",
    ];

    for (const name of finalNativeCommands) {
      expect(
        ledger.commands.find((command: { name: string }) => command.name === name),
      ).toMatchObject({
        disposition: "native",
        nativeReplacement: expect.not.stringMatching(/^SwiftUI\/AppKit platform service$/),
      });
    }
  });

  it("requires unique visual route and window identifiers", () => {
    for (const file of ["routes.json", "windows.json"]) {
      const ledger = JSON.parse(readFileSync(join(parity, file), "utf8"));
      const rows = ledger.routes ?? ledger.windows;
      const ids = rows.map((row: { id: string }) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(rows.every((row: { owner: string }) => row.owner === "native")).toBe(true);
      expect(rows.every((row: { visualRequired: boolean }) => row.visualRequired)).toBe(true);
    }
  });
});
