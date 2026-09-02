import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const main = readFileSync(
  fileURLToPath(new URL("./main.ts", import.meta.url)),
  "utf8",
);

describe("desktop-alt embedded Work bundle boundary", () => {
  it("keeps the default-off Work shell behind mountHqWork's dynamic import", () => {
    const mountHqWork = main.match(
      /mountHqWork:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \},\n\}\)/,
    );
    const dynamicImports =
      main.match(/import\(\s*["']\.\/HqWorkWorkShell\.svelte["']\s*\)/g) ?? [];

    expect(
      main,
      "Regression: HqWorkWorkShell must not be statically imported at module top level, or flag-off users download the embedded Work bundle.",
    ).not.toMatch(
      /^\s*import(?:\s+[^"']+?\s+from)?\s*["']\.\/HqWorkWorkShell\.svelte["'];?\s*$/m,
    );
    expect(
      dynamicImports,
      "Regression: HqWorkWorkShell must remain a single dynamic import so flag-off users do not download the embedded Work bundle.",
    ).toHaveLength(1);
    expect(
      mountHqWork?.[1],
      "Regression: the Work shell dynamic import must be reached only from mountHqWork after the flag resolves truthy.",
    ).toContain("import(\n      './HqWorkWorkShell.svelte'\n    )");
  });
});
