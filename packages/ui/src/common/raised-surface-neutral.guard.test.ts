// OWNER-R16: every raised surface (sheet, dialog, popover, menu, picker,
// tooltip, toast) paints the neutral Core / Launch menu surface. The blue cast
// came from the older slate tokens (--panel-bg rgba(44,44,54), --v4-popover
// rgb(44 44 54), --v4-surface-solid #1e1e24) that sheets such as Deploy access
// painted. This guard keeps the raised-surface tokens neutral in every theme
// block, keeps the shared token files on the app's own surface values, and
// lints every raised-surface rule in packages/ui and apps/sync.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const TOKEN_FILES = [
  "packages/ui/src/home/tokens.css",
  "packages/ui/src/chat/tokens.css",
  "packages/ui/src/chat/chat-tokens.css",
  "apps/sync/src/desktop-alt/v4/tokens.css",
];
const RAISED_TOKENS = ["--v4-popover", "--v4-popover-strong", "--v4-surface-solid", "--panel-bg", "--panel-edge", "--elevated", "--pop-bg", "--v4-raised"];

/** Call windows keep their own green theme; it is not a blue or purple cast. */
const ALLOW = new Set(["apps/sync/src/call/CallShell.svelte"]);

const LITERAL = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;

export function channels(literal: string): [number, number, number] | null {
  const t = literal.trim();
  if (t.startsWith("#")) {
    let h = t.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
    h = h.slice(0, 6);
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** A neutral surface: red, green and blue differ by no more than 2. */
export function isNeutral(literal: string): boolean {
  const c = channels(literal);
  return !c || Math.max(...c) - Math.min(...c) <= 2;
}

function declarations(css: string, name: string): string[] {
  const re = new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+);`, "g");
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(re)].map((m) => m[1].trim());
}

const SURFACE = /(sheet|popover|popout|menu|modal|dialog|dropdown|palette|picker|toast|tooltip)/i;
const NOT_SURFACE = /:(hover|focus|active|disabled)|scrim|backdrop|::/;
const OLD_TOKEN = /--(ice|vio)[\w-]*|--panel-bg|--v4-surface-solid|accent-soft/;

export function raisedSurfaceViolations(source: string): string[] {
  const out: string[] = [];
  for (const style of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].replace(/\s+/g, " ").trim();
      const lasts = selector.split(",").map((part) => part.trim().split(" ").pop() ?? "");
      if (!lasts.some((last) => SURFACE.test(last) && !NOT_SURFACE.test(last))) continue;
      for (const decl of rule[2].matchAll(/(?:^|[;\s])(background(?:-color)?|border(?:-color)?)\s*:\s*([^;]+)/g)) {
        const value = decl[2].replace(/\s+/g, " ").trim();
        for (const literal of value.match(LITERAL) ?? []) {
          if (!isNeutral(literal)) out.push(`${selector} { ${decl[1]}: ${value} }`);
        }
        if (decl[1].startsWith("background") && OLD_TOKEN.test(value) && !value.startsWith("var(--overlay-bg")) {
          out.push(`${selector} { ${decl[1]}: ${value} } paints an old tinted token`);
        }
      }
    }
  }
  return out;
}

describe("raised surfaces are the neutral Core menu surface (OWNER-R16)", () => {
  it.each(TOKEN_FILES)("%s keeps every raised-surface token neutral", (file) => {
    const css = read(file);
    const tinted: string[] = [];
    for (const name of RAISED_TOKENS) {
      for (const value of declarations(css, name)) {
        for (const literal of value.match(LITERAL) ?? []) {
          if (!isNeutral(literal)) tinted.push(`${name}: ${value}`);
        }
      }
    }
    expect(tinted).toEqual([]);
  });

  it("the shared token files use the app's own popover values", () => {
    const app = read("apps/sync/src/desktop-alt/v4/tokens.css");
    for (const file of ["packages/ui/src/home/tokens.css", "packages/ui/src/chat/tokens.css"]) {
      const css = read(file);
      for (const name of ["--v4-popover", "--v4-popover-strong"]) {
        const shared = new Set(declarations(css, name).filter((v) => /^rgb\(/.test(v)));
        const own = new Set(declarations(app, name).filter((v) => /^rgb\(/.test(v)));
        for (const value of shared) expect(own.has(value), `${file} ${name}: ${value}`).toBe(true);
      }
    }
  });

  it("the old panel token resolves to the overlay surface", () => {
    for (const value of declarations(read("packages/ui/src/chat/chat-tokens.css"), "--panel-bg")) {
      expect(value.startsWith("var(--v4-popover-strong")).toBe(true);
    }
  });

  it("every sheet, dialog, popover, menu, picker, tooltip and toast paints a neutral surface", () => {
    const files = execFileSync("git", ["ls-files", "packages/ui/src", "apps/sync/src"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".svelte") && !f.includes(".test.") && !ALLOW.has(f));
    const offenders: string[] = [];
    for (const file of files) {
      for (const v of raisedSurfaceViolations(read(file))) offenders.push(`${file}: ${v}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the lint catches a blue slate sheet, an old token, and passes the overlay token", () => {
    expect(raisedSurfaceViolations("<style>.sheet { background: rgba(44, 44, 54, 0.94); }</style>")).toHaveLength(1);
    expect(raisedSurfaceViolations("<style>.menu { background: var(--panel-bg); }</style>")).toHaveLength(1);
    expect(raisedSurfaceViolations("<style>.popover { border: 1px solid #2b2b33; }</style>")).toHaveLength(1);
    expect(raisedSurfaceViolations("<style>.sheet { background: var(--overlay-bg, var(--panel-bg)); }</style>")).toEqual([]);
    expect(raisedSurfaceViolations("<style>.row:hover { background: #2b2b33; }</style>")).toEqual([]);
    expect(isNeutral("#2a2b36")).toBe(false);
    expect(isNeutral("#2b2b2b")).toBe(true);
  });
});
