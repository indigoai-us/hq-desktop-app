// Contract for HQ_CORE_PRERELEASE, the walk and demo build switch that lets
// first-run setup and the HQ Core update check take an hq-core beta
// (docs/dev-switches.md, apps/sync/src-tauri/src/demo_build.rs).
//
// It is read at build time, so a shipped build has it only if the release
// path sets it. This test fails if any workflow, build script, package script
// or Tauri config does, and pins that the code reads it at build time only.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SWITCH = "HQ_CORE_PRERELEASE";

async function filesIn(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(resolve(rootDir, dir), { withFileTypes: true });
  return entries.filter((e) => e.isFile() && match(e.name)).map((e) => join(dir, e.name));
}

async function read(path: string): Promise<string> {
  return readFile(resolve(rootDir, path), "utf8");
}

describe("HQ_CORE_PRERELEASE", () => {
  it("is never set by a release workflow", async () => {
    const workflows = await filesIn(".github/workflows", (n) => n.endsWith(".yml") || n.endsWith(".yaml"));
    expect(workflows.some((p) => p.endsWith("release.yml"))).toBe(true);
    for (const path of workflows) {
      expect((await read(path)).includes(SWITCH), `${path} mentions ${SWITCH}`).toBe(false);
    }
  });

  it("is never set by a build script, package script or Tauri config", async () => {
    const paths = [
      ...(await filesIn(".github/scripts", () => true).catch(() => [])),
      ...(await filesIn("scripts", (n) => /\.(sh|mjs|js|ts)$/.test(n) && !n.endsWith(".test.ts"))),
      ...(await filesIn("apps/sync/scripts", () => true).catch(() => [])),
      ...(await filesIn("apps/sync/src-tauri", (n) => n.endsWith(".json"))),
      "package.json",
      "apps/sync/package.json",
      "apps/sync/vite.config.ts",
      "turbo.json",
    ];
    for (const path of paths) {
      const text = await read(path).catch(() => "");
      expect(text.includes(SWITCH), `${path} mentions ${SWITCH}`).toBe(false);
    }
  });

  it("is read at build time, so a build without it has it off", async () => {
    const rust = await read("apps/sync/src-tauri/src/demo_build.rs");
    expect(rust).toContain(`option_env!("${SWITCH}")`);
    expect(rust).not.toMatch(/std::env::var(_os)?\("HQ_CORE_PRERELEASE"/);
  });

  it("is in the dev doc", async () => {
    expect(await read("docs/dev-switches.md")).toContain(SWITCH);
  });
});
