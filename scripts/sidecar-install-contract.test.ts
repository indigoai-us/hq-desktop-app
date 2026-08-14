import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The recall-sdk-bridge sidecar is intentionally excluded from the pnpm
// workspace, yet tauri.conf.json bundles files from it (including its
// node_modules) as resources. On a fresh clone, `tauri dev` fails unless
// something installs the sidecar's deps. This contract test pins the fix:
// the root postinstall must install into every sidecar dir whose
// node_modules is bundled as a Tauri resource.

const repoRoot = resolve(__dirname, "..");
const tauriConfPath = join(repoRoot, "apps/sync/src-tauri/tauri.conf.json");
const tauriDir = dirname(tauriConfPath);

function bundledResourceSources(): string[] {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  return Object.keys(conf.bundle?.resources ?? {});
}

describe("sidecar install contract", () => {
  const nodeModulesSources = bundledResourceSources().filter((src) =>
    src.endsWith("node_modules"),
  );

  it("tauri.conf.json still bundles sidecar node_modules (else this test and the postinstall can be removed)", () => {
    expect(nodeModulesSources.length).toBeGreaterThan(0);
  });

  it("root postinstall installs deps for every bundled sidecar node_modules", () => {
    const rootPkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    const postinstall: string = rootPkg.scripts?.postinstall ?? "";
    for (const src of nodeModulesSources) {
      const sidecarDir = resolve(tauriDir, dirname(src));
      // Sidecar package must exist and be outside the workspace-installed tree.
      expect(existsSync(join(sidecarDir, "package.json"))).toBe(true);
      const relFromRoot = sidecarDir.slice(repoRoot.length + 1);
      expect(postinstall).toContain(relFromRoot);
      expect(postinstall).toContain("--ignore-workspace");
    }
  });
});
