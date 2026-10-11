/**
 * One 4px scrollbar everywhere in @hq/ui.
 *
 * `scrollbar-width` / `scrollbar-color` are standard properties that Chromium
 * and WebKit now implement, and where they are set they BEAT
 * `::-webkit-scrollbar`: `scrollbar-width: thin` drew an ~11px bar straight
 * through the 4px rule beneath it. So the contract is:
 *   - no `scrollbar-width` other than `none` (hiding a bar is legitimate);
 *   - no `scrollbar-color` at all;
 *   - every `::-webkit-scrollbar` that sets a size sets 4px;
 *   - a bar hidden with `scrollbar-width: none` is also hidden for WebKit, so
 *     the shared 4px rule cannot resurface it;
 *   - the shell ships one shared rule (chat/scrollbars.css) and loads it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(svelte|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Stylesheet text of a file: the <style> blocks of a component, or the CSS. */
function styleOf(path: string): string {
  const text = readFileSync(path, "utf8");
  const css = path.endsWith(".svelte")
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join("\n")
    : text;
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

type Rule = { selector: string; body: string };
function rules(css: string): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, " "),
    body: m[2],
  }));
}

function declarations(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g");
  return [...body.matchAll(re)].map((m) => m[1].trim());
}

const files = walk(SRC).map((path) => ({
  rel: relative(SRC, path),
  css: styleOf(path),
}));

describe("scrollbar contract (@hq/ui)", () => {
  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never sets scrollbar-width except `none`", () => {
    const offenders = files.flatMap(({ rel, css }) =>
      declarations(css, "scrollbar-width")
        .filter((value) => value !== "none")
        .map((value) => `${rel}: scrollbar-width: ${value}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never sets scrollbar-color (it disables ::-webkit-scrollbar styling)", () => {
    const offenders = files.flatMap(({ rel, css }) =>
      declarations(css, "scrollbar-color").map(
        (value) => `${rel}: scrollbar-color: ${value}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("sizes every ::-webkit-scrollbar at 4px", () => {
    const offenders = files.flatMap(({ rel, css }) =>
      rules(css)
        .filter((rule) => /::-webkit-scrollbar(?![-\w])/.test(rule.selector))
        .flatMap((rule) =>
          ["width", "height"].flatMap((prop) =>
            declarations(rule.body, prop)
              .filter((value) => value !== "4px")
              .map((value) => `${rel}: ${rule.selector} { ${prop}: ${value} }`),
          ),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("hides a bar for WebKit too wherever scrollbar-width: none hides it", () => {
    const offenders = files
      .filter(({ css }) => declarations(css, "scrollbar-width").includes("none"))
      .filter(
        ({ css }) =>
          !rules(css).some(
            (rule) =>
              /::-webkit-scrollbar(?![-\w])/.test(rule.selector) &&
              declarations(rule.body, "display").includes("none"),
          ),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

describe("the shell's shared scrollbar sheet", () => {
  const sheet = styleOf(fileURLToPath(new URL("./scrollbars.css", import.meta.url)));
  const sheetRules = rules(sheet);
  const ruleFor = (pseudo: string) =>
    sheetRules.find((rule) =>
      rule.selector
        .split(",")
        .map((s) => s.trim())
        .includes(`:where(.chat-shell) ${pseudo}`),
    );

  it("draws a 4px bar with zero added specificity", () => {
    const bar = ruleFor("::-webkit-scrollbar");
    expect(bar).toBeDefined();
    expect(declarations(bar!.body, "width")).toEqual(["4px"]);
    expect(declarations(bar!.body, "height")).toEqual(["4px"]);
    // Every selector is :where()-wrapped so component rules (including the
    // `display: none` hiders) always win.
    for (const rule of sheetRules) {
      for (const selector of rule.selector.split(",")) {
        expect(selector.trim().startsWith(":where(.chat-shell)")).toBe(true);
      }
    }
  });

  it("uses a 2px-radius thumb on the shell's line tokens over a transparent track", () => {
    const thumb = ruleFor("::-webkit-scrollbar-thumb");
    expect(declarations(thumb!.body, "border-radius")).toEqual(["2px"]);
    expect(declarations(thumb!.body, "background")).toEqual(["var(--line)"]);
    const hover = ruleFor("::-webkit-scrollbar-thumb:hover");
    expect(declarations(hover!.body, "background")).toEqual(["var(--line2)"]);
    const track = ruleFor("::-webkit-scrollbar-track");
    expect(declarations(track!.body, "background")).toEqual(["transparent"]);
  });

  it("is loaded by the desktop shell", () => {
    const desktopApp = readFileSync(
      new URL("../shell/DesktopApp.svelte", import.meta.url),
      "utf8",
    );
    expect(desktopApp).toContain('import "../chat/scrollbars.css";');
  });
});
