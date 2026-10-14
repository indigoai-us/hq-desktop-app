import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AUDIT-3: toast actions and the dismiss button show the shell focus ring
// (--v4-focus-ring), not the browser's default 1px blue ring.
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "ToastStack.svelte"), "utf8").split("<style")[1] ?? "";

describe("toast focus ring (AUDIT-3)", () => {
  it.each([".ts-act:focus-visible", ".ts-x:focus-visible"])("%s uses the shell focus ring", (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = css.match(new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`));
    expect(block, selector).not.toBeNull();
    expect(block![1]).toMatch(/outline:\s*2px solid var\(--v4-focus-ring/);
  });
});
