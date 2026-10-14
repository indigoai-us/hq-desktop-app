import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AUDIT-2: the Library vault home follows the console-rail type scale
 * (docs/design-standard-console-rail.md): the vault name is the one 20px/500
 * title, everything else on the home is 13px, weight at most 500, and the
 * eyebrow is sentence case rather than tracked caps.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "VaultExplorer.svelte"), "utf8");
const css = src.slice(src.indexOf("<style>"));
const home = css.slice(css.indexOf("/* ---- vault home ---- */"), css.indexOf(".vx-list {"));

describe("AUDIT-2 Library vault home type", () => {
  it("has the vault home block", () => {
    expect(home.length).toBeGreaterThan(100);
  });

  it("uses the title token for the heading and 13px for everything else", () => {
    expect(home).toMatch(/\.vx-home h1 \{[^}]*font-size: var\(--type-title/);
    const sizes = [...home.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.filter((px) => px !== 13)).toEqual([]);
  });

  it("caps weight at 500 and has no tracked caps", () => {
    const weights = [...home.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(weights.filter((w) => w > 500)).toEqual([]);
    expect(home).not.toMatch(/text-transform:\s*uppercase/);
  });
});

/**
 * AUDIT-2-09 / structural issue 3: the whole VaultExplorer (toolbar, tree,
 * note view, side rails) is on the same scale. 13px everywhere, weight at
 * most 500, 20px only for the page title (vault home h1 and the note title),
 * 11px mono only for the keyboard chord in the search box (the ⌘O hint).
 * The vault avatar is a glyph tile: its size is exempt, its weight is not.
 */
const FILES = ["VaultExplorer.svelte", "VaultTree.svelte", "NoteView.svelte"];
const TITLES = new Set([".vx-home h1", ".note-title"]);

function rules(file: string): Array<{ sel: string; body: string }> {
  const text = readFileSync(resolve(here, file), "utf8");
  const style = text.slice(text.lastIndexOf("<style"));
  return [...style.matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
    sel: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
    body: m[2],
  }));
}

describe("AUDIT-2 whole VaultExplorer type", () => {
  for (const file of FILES) {
    it(`${file}: 13px text, 20px title only, 11px mono only for the chord`, () => {
      const off: string[] = [];
      for (const { sel, body } of rules(file)) {
        for (const m of body.matchAll(/font-size:\s*([^;]+);/g)) {
          const v = m[1].trim();
          if (TITLES.has(sel) && /var\(--type-title/.test(v)) continue;
          if (sel.startsWith(".vx-avatar")) continue;
          if (v === "13px") continue;
          if (v === "11px" && sel === ".vx-search kbd" && /font-family:\s*var\(--font-mono/.test(body)) continue;
          off.push(`${sel} → ${v}`);
        }
      }
      expect(off).toEqual([]);
    });

    it(`${file}: weight at most 500`, () => {
      const heavy: string[] = [];
      for (const { sel, body } of rules(file)) {
        for (const m of body.matchAll(/font-weight:\s*([^;]+);/g)) {
          const n = Number(/(\d+)\)?\s*$/.exec(m[1].trim())?.[1]);
          if (!(n <= 500)) heavy.push(`${sel} → ${m[1].trim()}`);
        }
      }
      expect(heavy).toEqual([]);
    });
  }

  it("the ⌘O hint is mono", () => {
    const kbd = rules("VaultExplorer.svelte").find((r) => r.sel === ".vx-search kbd");
    expect(kbd?.body).toMatch(/font-family:\s*var\(--font-mono/);
  });
});
