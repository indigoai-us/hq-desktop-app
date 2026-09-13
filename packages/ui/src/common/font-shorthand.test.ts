// @vitest-environment node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `font: <weight> <size>/<line-height> inherit` is INVALID CSS: `inherit` is
 * not a font-family value inside the shorthand, so the browser drops the whole
 * declaration. The element then falls back to the UA default — on a `<button>`
 * that is Arial 13.3px/400 — which is how the company header's "Add agent"
 * shipped a full weight and family off from the 12px/500 tabs beside it.
 *
 * The valid spelling is `font-family: inherit` plus the size/weight longhands.
 */
const ROOT = new URL("..", import.meta.url).pathname;

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, out);
    else if (entry.endsWith(".svelte")) out.push(full);
  }
  return out;
}

describe("CSS font shorthand", () => {
  it("never ends a `font:` shorthand with `inherit`", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, i) => {
        // Bare `font: inherit` is the valid control reset. Only a shorthand
        // that puts other values BEFORE `inherit` is the broken form.
        if (/font:\s*[^;]*\S\s+inherit\s*;/.test(line)) {
          offenders.push(`${file.slice(ROOT.length)}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
