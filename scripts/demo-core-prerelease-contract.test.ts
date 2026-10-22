// Contract for HQ_CORE_PRERELEASE, the walk and demo build switch that lets
// first-run setup and the HQ Core update check take an hq-core beta
// (docs/dev-switches.md, apps/sync/src-tauri/src/demo_build.rs).
//
// It is read at build time, so a shipped build has it only if the release
// path sets it. This test fails if any workflow, composite action, build
// script, Cargo build config, Cargo build script, package script or Tauri
// config does, and pins that the code reads it at build time only. It also
// pins DEMO_FLAG_DEFAULTS_ON, the flags such a build reads as on: the list,
// its empty answer without the switch, and the adapter's mirror of it.
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

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", ".turbo"]);

async function walk(dir: string, match: (path: string) => boolean): Promise<string[]> {
  const entries = await readdir(resolve(rootDir, dir), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) found.push(...(await walk(path, match)));
    } else if (e.isFile() && match(path)) {
      found.push(path);
    }
  }
  return found;
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

  it("is never set by a composite action, Cargo config or Cargo build script", async () => {
    const actions = await walk(".github/actions", () => true);
    const cargoConfigs = await walk(".", (p) => /(^|\/)\.cargo\/config(\.toml)?$/.test(p));
    const buildScripts = await walk(".", (p) => /(^|\/)build\.rs$/.test(p));
    expect(actions).toContain(join(".github/actions", "pinned-rust-toolchain", "action.yml"));
    expect(buildScripts).toContain(join("apps/sync/src-tauri", "build.rs"));
    for (const path of [...actions, ...cargoConfigs, ...buildScripts]) {
      expect((await read(path)).includes(SWITCH), `${path} mentions ${SWITCH}`).toBe(false);
    }
  });

  it("is in the dev doc", async () => {
    expect(await read("docs/dev-switches.md")).toContain(SWITCH);
  });
});

describe("DEMO_FLAG_DEFAULTS_ON", () => {
  const FOUND_APPS = "desktop.first-run-found-apps-v1";
  const VISUAL_FIRST_RUN = "desktop.visual-first-run";
  const LISTED = [FOUND_APPS, VISUAL_FIRST_RUN];

  function rustList(rust: string): string[] {
    const match = rust.match(/pub const DEMO_FLAG_DEFAULTS_ON: &\[&str\] = &\[([^\]]*)\];/);
    expect(match, "DEMO_FLAG_DEFAULTS_ON in demo_build.rs").not.toBeNull();
    return [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  it("lists only the first-run found-apps and visual first-run flags", async () => {
    expect(rustList(await read("apps/sync/src-tauri/src/demo_build.rs"))).toEqual(LISTED);
  });

  it("is an empty list from demo_flag_defaults_on in a build without the switch", async () => {
    const rust = await read("apps/sync/src-tauri/src/demo_build.rs");
    // The command answers for this build's compile-time switch only ...
    expect(rust).toMatch(
      /pub fn demo_flag_defaults_on\(\) -> Vec<String> \{\s*flag_defaults_on\(core_prerelease\(\)\)\s*\}/,
    );
    // ... and off is the empty list, with a Rust test holding it there.
    expect(rust).toMatch(
      /pub fn flag_defaults_on\(on: bool\) -> Vec<String> \{\s*if on \{[\s\S]*?\} else \{\s*Vec::new\(\)\s*\}\s*\}/,
    );
    expect(rust).toContain("fn defaults_on_list_is_empty_when_the_switch_is_off()");
    expect(rust).toContain("assert!(flag_defaults_on(false).is_empty());");
  });

  it("is registered as a Tauri command and applied by feature_flag_read", async () => {
    expect(await read("apps/sync/src-tauri/src/main.rs")).toContain(
      "demo_build::demo_flag_defaults_on,",
    );
    const hqPro = await read("apps/sync/src-tauri/src/commands/hq_pro.rs");
    expect(hqPro).toContain("feature_flag_read_for_build(crate::demo_build::core_prerelease(), flag,");
    expect(hqPro).toContain("crate::demo_build::apply_flag_default(demo_on, flag, read)");
  });

  it("matches the adapter's candidate set", async () => {
    const adapter = await read("packages/platform/src/tauri/sync-adapter.ts");
    const match = adapter.match(
      /export const DEMO_FLAG_DEFAULT_CANDIDATES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/,
    );
    expect(match, "DEMO_FLAG_DEFAULT_CANDIDATES in sync-adapter.ts").not.toBeNull();
    const names = match![1].split(",").map((n) => n.trim()).filter(Boolean);
    expect(names).toEqual(["FIRST_RUN_FOUND_APPS_FLAG", "VISUAL_FIRST_RUN_FLAG"]);
    const flags = await read("packages/platform/src/flags.ts");
    expect(flags).toContain(`export const FIRST_RUN_FOUND_APPS_FLAG = "${FOUND_APPS}";`);
    expect(flags).toContain(`export const VISUAL_FIRST_RUN_FLAG = "${VISUAL_FIRST_RUN}";`);
    expect(rustList(await read("apps/sync/src-tauri/src/demo_build.rs"))).toEqual(LISTED);
  });

  it("is in the dev doc", async () => {
    const doc = await read("docs/dev-switches.md");
    expect(doc).toContain("DEMO_FLAG_DEFAULTS_ON");
    expect(doc).toContain(FOUND_APPS);
    expect(doc).toContain(VISUAL_FIRST_RUN);
  });
});
