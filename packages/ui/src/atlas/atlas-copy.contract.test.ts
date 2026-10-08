import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AUDIT-3: Atlas copy is sentence case. Owner, 2026-10-04: the section titles
// on the map are the exception. They are small, uppercase and muted so item
// names carry the hierarchy; they stay sans, and the source text stays
// sentence case (uppercase is applied in CSS only).
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

  it("draws district labels small, uppercase and muted, in sans", () => {
    const region = map.match(/\.region \{([^}]*)\}/)?.[1] ?? "";
    expect(region).toMatch(/text-transform:\s*uppercase/);
    expect(region).toMatch(/font-size:\s*11px/);
    expect(region).toMatch(/fill:\s*var\(--v4-text-3\)/);
    expect(region).not.toMatch(/font-mono/);
  });
});
