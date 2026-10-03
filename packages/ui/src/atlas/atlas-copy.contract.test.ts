import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AUDIT-3: Atlas copy is sentence case and district labels follow the
// section-label rule (sans, no tracking, no uppercase).
const HERE = dirname(fileURLToPath(import.meta.url));
const map = readFileSync(join(HERE, "AtlasMap.svelte"), "utf8");
const inspector = readFileSync(join(HERE, "AtlasInspector.svelte"), "utf8");

describe("Atlas copy and labels (AUDIT-3)", () => {
  it("starts the map hint with a capital and names the 0 key", () => {
    const hint = map.match(/<span class="hint">([^<]*)<\/span>/)?.[1] ?? "";
    expect(hint).toMatch(/^[A-Z]/);
    expect(hint).toContain("Press 0");
  });

  it("labels the inspector's company section in sentence case", () => {
    const kinds = [...inspector.matchAll(/<div class="kind">([^<{]+)<\/div>/g)].map((m) => m[1].trim());
    for (const kind of kinds) expect(kind, kind).toMatch(/^[A-Z]/);
  });

  it("draws district labels in sans without tracking or uppercase", () => {
    const region = map.match(/\.region \{([^}]*)\}/)?.[1] ?? "";
    expect(region).not.toMatch(/text-transform:\s*uppercase/);
    expect(region).not.toMatch(/letter-spacing/);
    expect(region).not.toMatch(/font-mono/);
  });
});
