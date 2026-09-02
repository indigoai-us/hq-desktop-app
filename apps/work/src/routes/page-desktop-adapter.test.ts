import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createSyncPlatformAdapter } from "@hq/platform";
import { describe, expect, it } from "vitest";

describe("HQ Work desktop platform adapter", () => {
  it("does not use SvelteKit app-local aliases in the exported shell", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../lib/WorkShell.svelte", import.meta.url)),
      "utf8",
    );
    const appLocalSpecifiers = page.match(/\$(?:lib|app)\/[^\s"'`]+/g) ?? [];

    expect(
      appLocalSpecifiers,
      `WorkShell.svelte contains forbidden app-local import: ${appLocalSpecifiers[0] ?? "none"}`,
    ).toEqual([]);
  });

  it("constructs the shared Sync adapter and maps Board reads to the host command", async () => {
    const page = readFileSync(
      fileURLToPath(new URL("../lib/WorkShell.svelte", import.meta.url)),
      "utf8",
    );

    expect(page).toContain("createSyncPlatformAdapter,");
    expect(page).toContain(
      "? createSyncPlatformAdapter({ invoke: tauriInvoke })",
    );
    expect(page).toContain(
      `: new WebPlatformAdapter({
        baseUrl: hqProApiUrl(),
        fetch: hqProFetch,
        onUnauthorized: redirectToSigninWithCallback,
      })`,
    );
    expect(page).toContain("const workFetch: HqProFetch = hqProFetch;");
    expect(page).toContain("loadWorkThreads(roster, workFetch)");

    const commands: string[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (command) => {
        commands.push(command);
        return { stories: [] };
      },
    });

    await expect(adapter.company.getBoard("indigo")).resolves.toEqual({
      ok: true,
      value: { stories: [] },
    });
    expect(commands).toEqual(["get_company_board"]);
    expect(commands).not.toContain("get_board");
  });
});
