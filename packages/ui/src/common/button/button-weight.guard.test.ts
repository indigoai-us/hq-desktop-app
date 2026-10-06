/**
 * Owner feedback (2026-10-05): "some buttons have bolder text than the rest.
 * please use the thinner font". RailButton sets the standard label weight (500).
 * No hand-rolled button rule in @hq/ui may set a heavier one.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUTTON_SELECTOR = /(\bbtn\b|\.btn-|button|-btn\b|\bcta\b|\[data-rail-btn\])/iu;
const HEAVY = /font-weight:\s*(600|650|700|800|bold)\b/u;
const AT_RULE = /^\s*@(media|supports|container|keyframes|layer)/u;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(svelte|css)$/u.test(entry.name) ? [path] : [];
  });
}

/** `file:line [selector] declaration` for every button rule heavier than 500. */
function heavyButtonRules(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: string[] = [];
  let selector = "";
  lines.forEach((line, index) => {
    if (line.includes("{") && !AT_RULE.test(line)) {
      const parts = [line.split("{")[0] ?? ""];
      for (let back = index; back > 0 && lines[back - 1]!.trim().endsWith(","); back--) {
        parts.unshift(lines[back - 1]!);
      }
      selector = parts.map((part) => part.trim()).join(" ");
    }
    if (HEAVY.test(line) && BUTTON_SELECTOR.test(selector) && !selector.includes("<")) {
      found.push(`${relative(SRC, file)}:${index + 1} [${selector}] ${line.trim()}`);
    }
  });
  return found;
}

describe("button label weight", () => {
  it("RailButton labels use weight 500", () => {
    expect(readFileSync(resolve(SRC, "common/button/RailButton.svelte"), "utf8")).toMatch(/font-weight: 500;/u);
  });

  it("no button rule sets a weight heavier than 500", () => {
    expect(sources(SRC).flatMap(heavyButtonRules)).toEqual([]);
  });

  it("the Submit a pack buttons use weight 500", () => {
    const css = readFileSync(resolve(SRC, "marketplace/SubmitPanel.svelte"), "utf8");
    expect(css).toMatch(/\.btn \{[^}]*font-weight: 500;/u);
  });
});
