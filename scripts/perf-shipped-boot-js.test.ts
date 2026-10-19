import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { bootRoots, staticFiles } from "./perf/shipped-boot-js.mjs";

describe("shipped boot JS command", () => {
  it("is a committed package script", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["perf:boot-js"]).toBe("node scripts/perf/shipped-boot-js.mjs");
  });

  it("counts the desktop entry, the shell it imports at boot and their static imports", () => {
    const manifest = {
      "desktop-alt.html": {
        file: "assets/desktopAlt-a.js",
        isEntry: true,
        imports: ["_hq-shared-b.js"],
        dynamicImports: ["src/desktop-alt/HqWorkWorkShell.svelte"],
      },
      "src/desktop-alt/HqWorkWorkShell.svelte": {
        file: "assets/HqWorkWorkShell-c.js",
        isDynamicEntry: true,
        imports: ["_hq-shared-b.js"],
        dynamicImports: ["../../packages/ui/src/company/TeamPage.svelte"],
      },
      "_hq-shared-b.js": { file: "assets/hq-shared-b.js" },
      "../../packages/ui/src/company/TeamPage.svelte": {
        file: "assets/TeamPage-d.js",
        isDynamicEntry: true,
        imports: ["_hq-shared-b.js"],
      },
      "index.html": { file: "assets/main-e.js", isEntry: true, imports: ["_hq-shared-b.js"] },
    };
    const roots = bootRoots(manifest);
    expect([...staticFiles(manifest, roots.desktop)].sort()).toEqual([
      "assets/HqWorkWorkShell-c.js",
      "assets/desktopAlt-a.js",
      "assets/hq-shared-b.js",
    ]);
    expect([...staticFiles(manifest, roots.main)].sort()).toEqual([
      "assets/hq-shared-b.js",
      "assets/main-e.js",
    ]);
  });
});
