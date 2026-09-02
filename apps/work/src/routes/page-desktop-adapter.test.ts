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
    const hqProClient = readFileSync(
      fileURLToPath(new URL("../lib/hq-pro-client.ts", import.meta.url)),
      "utf8",
    );
    const appLocalSpecifiers = `${page}\n${hqProClient}`.match(
      /\$(?:lib|app|env)\/[^\s"'`]+/g,
    ) ?? [];

    expect(
      appLocalSpecifiers,
      `The WorkShell module graph contains a SvelteKit-only import: ${appLocalSpecifiers[0] ?? "none"}`,
    ).toEqual([]);
  });

  it("keeps public API configuration at the SvelteKit host boundary", () => {
    const rootRoute = readFileSync(
      fileURLToPath(new URL("./+page.svelte", import.meta.url)),
      "utf8",
    );

    expect(rootRoute).toContain('import { env } from "$env/dynamic/public";');
    expect(rootRoute).toContain(
      "<WorkShell {data} apiUrl={env.PUBLIC_HQ_PRO_API_URL} />",
    );
  });

  it("gives an embedding host's runtime kind precedence over ambient detection", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../lib/WorkShell.svelte", import.meta.url)),
      "utf8",
    );

    expect(
      page,
      "A host-supplied runtimeKind must select the platform adapter before Work falls back to its existing Tauri detection.",
    ).toMatch(
      /const runtime = runtimeKind \?\? \(isTauriRuntime\(\) \? "desktop" : "web"\);/,
    );
    expect(page).toContain('const adapter: PlatformAdapter = runtime === "desktop"');
  });

  it("constructs the shared Sync adapter and maps Board reads to the host command", async () => {
    const page = readFileSync(
      fileURLToPath(new URL("../lib/WorkShell.svelte", import.meta.url)),
      "utf8",
    );

    expect(page).toContain("createSyncPlatformAdapter,");
    expect(page).toContain(
      '? createSyncPlatformAdapter({ invoke: tauriInvoke })',
    );
    expect(page).toContain(
      `: new WebPlatformAdapter({
        baseUrl: resolveHqProApiUrl(),
        fetch: hqProFetch,
        onUnauthorized: redirectToSigninWithCallback,
      })`,
    );
    expect(page).toContain(
      "const resolveHqProApiUrl = () => hqProApiUrl(apiUrl);",
    );
    expect(page).toContain("configureHqProApiUrl(apiUrl);");
    expect(page).toContain("const workFetch = hqProFetch;");
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
