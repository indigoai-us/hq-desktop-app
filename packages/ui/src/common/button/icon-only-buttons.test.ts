import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Owner, 2026-10-22: "the icon should sit in the center of the button".
 * rail-type.css puts 6px after a button's leading icon to separate it from
 * its label. In a button with no label that 6px pushed the icon 3px left of
 * centre. Icon-only buttons carry `data-icon-only`, which the rule skips;
 * this fails on any icon-only button in @hq/ui that does not.
 */
const SRC = resolve(process.cwd(), "src");

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith(".svelte") ? [path] : [];
  });
}

/** Opening tag end, respecting `{…}` expressions (arrow functions hold `>`). */
function openTagEnd(src: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i + 1;
  }
  return -1;
}

function isIconOnly(body: string): boolean {
  let rest = body.replace(/<!--[\s\S]*?-->/g, "");
  if (!rest.includes("<RailIcon")) return false;
  rest = rest.replace(/<RailIcon\b(?:[^>{]|\{[^}]*\})*\/>/g, "");
  rest = rest.replace(/\{[#:/](?:if|else|each)[^}]*\}/g, "");
  return rest.trim() === "";
}

describe("icon-only buttons", () => {
  it("are marked data-icon-only so the label gap does not push the icon off centre", () => {
    const unmarked: string[] = [];
    for (const file of svelteFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      let at = src.indexOf("<button");
      while (at >= 0) {
        const end = openTagEnd(src, at + 7);
        const close = end < 0 ? -1 : src.indexOf("</button>", end);
        if (close < 0) break;
        const tag = src.slice(at, end);
        if (!tag.includes("data-rail-btn") && isIconOnly(src.slice(end, close)) && !tag.includes("data-icon-only")) {
          unmarked.push(`${file.slice(SRC.length + 1)}:${src.slice(0, at).split("\n").length}`);
        }
        at = src.indexOf("<button", close);
      }
    }
    expect(unmarked).toEqual([]);
  });

  it("are skipped by the leading-icon gap", () => {
    const css = readFileSync(join(SRC, "common/button/rail-type.css"), "utf8");
    expect(css).toMatch(
      /button:not\(\[data-rail-btn\]\):not\(\[data-icon-only\]\) > svg\.rail-icon:first-child \{[^}]*margin-inline-end: 6px/,
    );
  });
});
