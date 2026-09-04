import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const main = readFileSync(
  fileURLToPath(new URL("./main.ts", import.meta.url)),
  "utf8",
);

describe("desktop-alt embedded Work bundle boundary", () => {
  it("keeps the workspace shell code-split behind mountHqWork", () => {
    const mountHqWork = main.match(
      /mountHqWork:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n  \},\n\}\)/,
    );
    const dynamicImports =
      main.match(/import\(\s*["']\.\/HqWorkWorkShell\.svelte["']\s*\)/g) ?? [];

    expect(
      main,
      "Regression: HqWorkWorkShell must not be statically imported at module top level.",
    ).not.toMatch(
      /^\s*import(?:\s+[^"']+?\s+from)?\s*["']\.\/HqWorkWorkShell\.svelte["'];?\s*$/m,
    );
    expect(
      dynamicImports,
      "Regression: HqWorkWorkShell must remain a single dynamic import.",
    ).toHaveLength(1);
    expect(
      mountHqWork?.[1],
      "Regression: the workspace shell dynamic import must be reached from mountHqWork.",
    ).toContain("import('./HqWorkWorkShell.svelte')");
    expect(main).not.toMatch(/getHqWorkHandoff|mountLegacy|getHandoff|DesktopApp/);
  });
});
