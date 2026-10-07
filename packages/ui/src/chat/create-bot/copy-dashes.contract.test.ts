import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AUDIT-3: New bot copy never uses a spaced hyphen as a dash. Sentences
// break with a period; label pairs use the " · " separator the rest of the
// app uses ("Personal · acts as you").
const HERE = dirname(fileURLToPath(import.meta.url));

describe("New bot copy punctuation (AUDIT-3)", () => {
  const files = readdirSync(HERE).filter((f) => /\.(svelte|ts)$/.test(f) && !f.includes(".test."));
  it.each(files)("%s has no spaced hyphen inside user-facing strings", (file) => {
    const src = readFileSync(join(HERE, file), "utf8");
    const strings = [...src.matchAll(/(["`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]);
    const markup = file.endsWith(".svelte") ? [...src.split("<style")[0].matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1]) : [];
    for (const text of [...strings, ...markup]) {
      if (!/[A-Za-z]{2,} - [A-Za-z]{2,}/.test(text)) continue;
      expect(text, `${file}: ${text}`).not.toMatch(/[A-Za-z]{2,} - [A-Za-z]{2,}/);
    }
  });
});
