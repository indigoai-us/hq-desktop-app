import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "agent-avatars.ts"),
  "utf8",
);

describe("agent-avatars production bundle guard", () => {
  it("does not guard import.meta.glob behind typeof", () => {
    // The guard survives bundling (Vite only rewrites the *call*) and
    // disables the set in production, where import.meta.glob is undefined.
    // A behaviour test cannot see that: Vitest defines import.meta.glob.
    const code = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/typeof\s+import\.meta\.glob/);
    expect(code).toMatch(/import\.meta\.glob\(/);
  });
});
