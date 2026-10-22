import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * feedback_fa5271ee: a 9-column markdown table in the Library note view was
 * squeezed into the ~650px reading column and its cells broke inside words
 * ("Shopi/fy"). The note body uses `overflow-wrap: anywhere`, which lets a
 * table cell shrink to one character wide, so the table never got wider than
 * the column and its horizontal scroll never engaged. Table cells must wrap
 * only between words, and the table must scroll horizontally.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "NoteView.svelte"), "utf8");
const style = src.slice(src.lastIndexOf("<style"));

function rule(selector: string): string {
  for (const m of style.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const sels = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((s) => s.trim());
    if (sels.includes(selector)) return m[2];
  }
  return "";
}

describe("NoteView wide markdown tables", () => {
  it("lets the table scroll horizontally instead of squeezing into the column", () => {
    // The shared renderer wraps each table in .markdown-table-scroll; that box
    // scrolls, and the table sizes to its content so it can grow past it.
    const scroll = rule(".markdown-body :global(.markdown-table-scroll)");
    expect(scroll).toMatch(/overflow-x:\s*auto/);
    expect(scroll).toMatch(/max-width:\s*100%/);
    const table = rule(".markdown-body :global(table)");
    expect(table).toMatch(/width:\s*max-content/);
    expect(table).toMatch(/min-width:\s*100%/);
  });

  it("does not break table cells inside words", () => {
    for (const cell of [".markdown-body :global(th)", ".markdown-body :global(td)"]) {
      const body = rule(cell);
      expect(body, cell).toMatch(/overflow-wrap:\s*normal/);
      expect(body, cell).toMatch(/word-break:\s*normal/);
    }
  });
});
