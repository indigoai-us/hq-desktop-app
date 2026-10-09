// Contract for the dev-only build switches (docs/dev-switches.md).
//
// The switches are read at build time, so a release build has them only if
// the release path sets them. This test pins that no workflow, build script,
// package script or Tauri config does, that the code still reads each one at
// build time, and that the doc lists every one.
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NATIVE = ["HQ_SCRATCH_BUILD", "HQ_SCRATCH_IMPORT_HQ_BIN", "HQ_SCRATCH_IMPORT_SCANNER"] as const;
const VITE = ["VITE_HQ_DEV_FIRST_RUN_FORCE", "VITE_HQ_DEV_FIRST_RUN_DRY"] as const;
const ALL = [...NATIVE, ...VITE];

async function filesIn(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(resolve(rootDir, dir), { withFileTypes: true });
  return entries.filter((e) => e.isFile() && match(e.name)).map((e) => join(dir, e.name));
}

async function read(path: string): Promise<string> {
  return readFile(resolve(rootDir, path), "utf8");
}

describe("dev-only build switches", () => {
  it("are never set on the release path: workflows, build scripts, package scripts, Tauri configs", async () => {
    const paths = [
      ...(await filesIn(".github/workflows", (n) => n.endsWith(".yml") || n.endsWith(".yaml"))),
      ...(await filesIn(".github/scripts", () => true).catch(() => [])),
      ...(await filesIn("scripts", (n) => /\.(sh|mjs|js|ts)$/.test(n) && !n.endsWith(".test.ts"))),
      ...(await filesIn("apps/sync/scripts", () => true).catch(() => [])),
      ...(await filesIn("apps/sync/src-tauri", (n) => n.endsWith(".json"))),
      "package.json",
      "apps/sync/package.json",
      "apps/sync/vite.config.ts",
      "turbo.json",
    ];
    expect(paths.some((p) => p.endsWith("release.yml"))).toBe(true);
    for (const path of paths) {
      const text = await read(path).catch(() => "");
      for (const name of ALL) {
        expect(text.includes(name), `${path} mentions ${name}`).toBe(false);
      }
    }
  });

  it("are not set by a committed env file, or anywhere in apps/work", async () => {
    const tracked = execFileSync("git", ["-C", rootDir, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const envFiles = tracked.filter((path) => /(^|\/)\.env(\.|$)/.test(path));
    const work = tracked.filter((path) => path.startsWith("apps/work/") && !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(path));
    expect(work.length).toBeGreaterThan(0);
    for (const path of [...envFiles, ...work]) {
      const text = await read(path).catch(() => "");
      for (const name of ALL) {
        expect(text.includes(name), `${path} mentions ${name}`).toBe(false);
      }
    }
  });

  it("are read at build time, so a build without them has them off", async () => {
    const rust = await read("apps/sync/src-tauri/src/scratch_build.rs");
    for (const name of NATIVE) expect(rust).toContain(`option_env!("${name}")`);
    // Run-time env is not read for them.
    expect(rust).not.toMatch(/std::env::var\("HQ_SCRATCH/);
    const ui = await read("packages/ui/src/chat/first-run/dev-switches.ts");
    for (const name of VITE) expect(ui).toContain(`import.meta.env.${name}`);
  });

  it("are all in the dev doc", async () => {
    const doc = await read("docs/dev-switches.md");
    for (const name of [...ALL, "HQ_UPDATER_DISABLED"]) expect(doc).toContain(name);
  });
});
