import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the operator's standing constraint on this codebase:
 *
 *   "all 3 platforms should have the same folder. svelte. no duplicate code at
 *    all. use if/else or ternary or switch cases"
 *
 * Web, desktop and mobile share ONE Svelte source (`apps/work` + `packages/*`).
 * Platform divergence is expressed inline — a branch on the resolved host
 * platform or a capability flag — never by forking a component per platform.
 *
 * These assertions are cheap and they fail loudly the moment someone reaches
 * for copy-paste, which is the exact regression this file exists to prevent.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".svelte-kit",
  ".vercel",
  "build",
  "dist",
  "target",
  "gen",
  "coverage",
  ".git",
]);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // directory absent — nothing to police
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const rel = (p: string) => relative(REPO_ROOT, p);

describe("one Svelte source across web, desktop and mobile", () => {
  it("has no per-platform component variants", async () => {
    // A `Foo.mobile.svelte` beside a `Foo.svelte` is the forked-file failure
    // mode. Divergence belongs inside the component, behind a branch.
    const files = await walk(join(REPO_ROOT, "apps"));
    const variants = files
      .filter((f) => f.endsWith(".svelte"))
      .filter((f) => /\.(mobile|ios|android|desktop|web)\.svelte$/.test(f))
      .map(rel);
    expect(variants).toEqual([]);
  });

  it("keeps the mobile native shell free of application source", async () => {
    // `apps/work/src-tauri` is a native wrapper. Rust and platform config are
    // expected; Svelte or app TypeScript there would mean a second app.
    const shell = join(REPO_ROOT, "apps/work/src-tauri");
    const files = await walk(shell);
    const appSource = files
      .filter((f) => [".svelte", ".ts", ".tsx", ".jsx"].includes(extname(f)))
      .map(rel);
    expect(appSource).toEqual([]);
  });

  it("adds no second SvelteKit app for mobile", async () => {
    const files = await walk(join(REPO_ROOT, "apps"));
    const configs = files
      .filter((f) => /svelte\.config\.[jt]s$/.test(f))
      .map(rel)
      .sort();
    // apps/work is the shared shell; apps/sync is the existing desktop host.
    // Mobile must reuse apps/work rather than introduce a third.
    expect(configs).toEqual(["apps/sync/svelte.config.js", "apps/work/svelte.config.js"]);
  });

  it("has no byte-identical Svelte components across app trees", async () => {
    const files = (await walk(join(REPO_ROOT, "apps"))).filter((f) =>
      f.endsWith(".svelte"),
    );
    const byHash = new Map<string, string[]>();
    for (const file of files) {
      const hash = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
      byHash.set(hash, [...(byHash.get(hash) ?? []), rel(file)]);
    }
    const copies = [...byHash.values()].filter((group) => group.length > 1);
    expect(copies).toEqual([]);
  });
});
