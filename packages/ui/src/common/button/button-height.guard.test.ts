/**
 * Owner feedback (2026-10-05): "the button height and padding on the top
 * menubar should be set as the standard for all buttons across the app. the
 * white button looks a bit taller ya?" The titlebar Launch / Core pill is the
 * reference. These contracts compute the pill's rendered block size from its
 * own rule and assert that the shared standard, and every button that uses
 * it (primary, secondary, ghost, dropdown pill), resolves to the same height.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
  if (!match) throw new Error(`rule ${selector} not found`);
  return match[1]!;
}

function decl(body: string, prop: string): string {
  const match = new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`, "u").exec(body);
  if (!match) throw new Error(`${prop} not found`);
  return match[1]!.trim();
}

const px = (value: string) => Number.parseFloat(value);

/** Rendered height of the titlebar pill: line box + block padding + border. */
function pillHeight(): number {
  const css = read("home/V4TitleBar.svelte");
  const pill = rule(css, ".v4-core-pill");
  const lineHeight = Number(/font:\s*400 13px\/([\d.]+)/u.exec(rule(css, ".v4-titlebar"))![1]);
  const [padBlock] = decl(pill, "padding").split(/\s+/u);
  const border = px(decl(pill, "border"));
  return px(decl(pill, "font-size")) * lineHeight + 2 * px(padBlock!) + 2 * border;
}

function tokens(): Record<string, string> {
  const css = read("common/button/button-standard.css");
  return Object.fromEntries([...css.matchAll(/(--hq-btn-[\w-]+):\s*([^;]+);/gu)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** Resolve --hq-btn-h from the token file, the same arithmetic calc() does. */
function standardHeight(): number {
  const t = tokens();
  return (
    px(t["--hq-btn-font-size"]!) * Number(t["--hq-btn-line-height"]) +
    2 * px(t["--hq-btn-pad-block"]!) +
    2 * px(t["--hq-btn-border"]!)
  );
}

describe("one button height, from the titlebar pill", () => {
  it("the standard height equals the titlebar pill height", () => {
    expect(pillHeight()).toBeCloseTo(30.85, 2);
    expect(standardHeight()).toBeCloseTo(pillHeight(), 5);
    expect(tokens()["--hq-btn-h"]).toContain("var(--hq-btn-pad-block)");
  });

  it("the standard padding, gap, radius and type match the pill", () => {
    const css = read("home/V4TitleBar.svelte");
    const pill = rule(css, ".v4-core-pill");
    const t = tokens();
    expect(decl(pill, "padding")).toBe(`${t["--hq-btn-pad-block"]} ${t["--hq-btn-pad-inline"]}`);
    expect(decl(pill, "gap")).toBe(t["--hq-btn-gap"]);
    expect(decl(pill, "border-radius")).toBe(t["--hq-btn-radius"]);
    expect(decl(pill, "font-size")).toBe(t["--hq-btn-font-size"]);
    expect(t["--hq-btn-font-weight"]).toBe("500");
  });

  it("RailButton (primary, secondary, ghost, danger) renders at the standard", () => {
    const css = read("common/button/RailButton.svelte");
    const base = rule(css, ".rail-btn");
    expect(decl(base, "height")).toBe("var(--hq-btn-h)");
    expect(decl(base, "padding")).toBe("0 var(--hq-btn-pad-inline)");
    expect(decl(base, "font-size")).toBe("var(--hq-btn-font-size)");
    expect(decl(base, "line-height")).toBe("var(--hq-btn-line-height)");
    // No variant or size overrides the block size.
    for (const variant of [".rail-btn.primary", ".rail-btn.ghost", ".rail-btn.danger"]) {
      expect(rule(css, variant)).not.toMatch(/height|padding/u);
    }
    expect(css).not.toMatch(/\.rail-btn\.compact\s*\{/u);
  });

  it("the dropdown pill renders at the standard", () => {
    expect(decl(rule(read("common/Dropdown.svelte"), ".dd-button"), "min-height")).toBe("var(--hq-btn-h)");
  });

  it("no labelled button rule hand-rolls a 26-36px height", () => {
    const BUTTON = /(\bbtn\b|\.btn-|button|-btn\b|\bcta\b|-action\b|-retry\b)/iu;
    const EXEMPT = /(command-list|nr-|qw-|\.menu button|nav button|\.app\b|notification-action-recovery|icon|svg|platforms button)/u;
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
        return /\.(svelte|css)$/u.test(entry.name) ? [path] : [];
      });
    const offenders = files(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const css = file.endsWith(".svelte") ? text.slice(Math.max(0, text.indexOf("<style"))) : text;
      return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
        .filter((m) => {
          const selector = m[1]!.split(/\s+/u).join(" ").trim();
          return !selector.startsWith("@") && BUTTON.test(selector) && !EXEMPT.test(selector)
            && /(?<![-\w])(min-)?height:\s*(2[6-9]|3[0-6])px;/u.test(m[2]!);
        })
        .map((m) => `${relative(SRC, file)} ${m[1]!.trim().split("\n").pop()}`);
    });
    expect(offenders).toEqual([]);
  });
});
