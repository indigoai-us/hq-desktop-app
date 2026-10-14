// OWNER-R6: no native <select> in any console-rail surface. Filters, sorts,
// pickers and sheet form fields use the one styled dropdown
// (common/Dropdown.svelte, loaded through common/LazyDropdown.svelte).
// Outside the console rail, and kept native on purpose:
//   packages/ui/src/meet/            the call window (device pickers)
//   apps/sync/src/components/        the legacy menubar and meeting windows
//   apps/sync/src/call/              the call window shell

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCAN = ["packages/ui/src", "apps/sync/src"];
const OUTSIDE_RAIL = ["packages/ui/src/meet/", "apps/sync/src/components/", "apps/sync/src/call/"];

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...svelteFiles(path));
    } else if (name.endsWith(".svelte")) {
      out.push(path);
    }
  }
  return out;
}

export function nativeSelects(source: string): number {
  const markup = source.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  return (markup.match(/<select\b/g) ?? []).length;
}

describe("no native select in the console rail (OWNER-R6)", () => {
  it("detects a native select in markup", () => {
    expect(nativeSelects('<label><select bind:value={x}><option>a</option></select></label>')).toBe(1);
    expect(nativeSelects('<script>const s = "<select>";</script><Dropdown />')).toBe(0);
  });

  it("every console-rail surface uses the shared dropdown", () => {
    const offenders: string[] = [];
    for (const base of SCAN) {
      for (const file of svelteFiles(join(root, base))) {
        const rel = relative(root, file);
        if (OUTSIDE_RAIL.some((prefix) => rel.startsWith(prefix))) continue;
        if (nativeSelects(readFileSync(file, "utf8")) > 0) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
