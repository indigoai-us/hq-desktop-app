import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("macOS bundle name and LaunchAgent label stay stable", () => {
  it("locks tauri productName, identifier, and the LaunchAgent label constant together", async () => {
    const [tauriRaw, launchagent, autostart, releaseDocs] = await Promise.all([
      readFile(resolve(rootDir, "apps/sync/src-tauri/tauri.conf.json"), "utf8"),
      readFile(resolve(rootDir, "crates/hq-platform/src/launchagent.rs"), "utf8"),
      readFile(resolve(rootDir, "crates/hq-platform/src/autostart.rs"), "utf8"),
      readFile(resolve(rootDir, "docs/RELEASE.md"), "utf8"),
    ]);

    const tauri = JSON.parse(tauriRaw) as {
      productName: string;
      identifier: string;
    };

    expect(tauri.productName).toBe("HQ");
    expect(tauri.identifier).toBe("ai.indigo.hq-sync-menubar");

    expect(launchagent).toContain(
      'pub const LAUNCH_AGENT_LABEL: &str = "ai.indigo.hq-sync-menubar";',
    );
    expect(launchagent).toContain('pub const PRODUCT_BUNDLE_NAME: &str = "HQ.app";');
    expect(launchagent).toContain('pub const LEGACY_BUNDLE_NAME: &str = "HQ Sync.app";');

    expect(`${tauri.productName}.app`).toBe("HQ.app");
    expect(tauri.identifier).toBe("ai.indigo.hq-sync-menubar");

    expect(autostart).toContain("LAUNCH_AGENT_LABEL");
    expect(autostart).toContain("CURRENT_BUNDLE_EXECUTABLE");

    expect(releaseDocs).toContain("`HQ.app`");
    expect(releaseDocs).toContain("ai.indigo.hq-sync-menubar");
    expect(releaseDocs).toContain("do not rename");
  });
});
