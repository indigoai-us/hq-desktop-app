import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("hosted Board tab", () => {
  it("does not paint work-mesh activity as Board stories", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./+page.svelte", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("boardFromWorkItems");
    expect(src).not.toContain("/v1/work-mesh/work");
    expect(src).toContain("ensureProjectMeta(row)?.board");
  });
});
