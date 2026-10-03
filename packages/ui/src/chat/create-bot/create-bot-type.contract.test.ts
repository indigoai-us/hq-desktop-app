import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The New bot wizard follows the Messages type grammar
 * (docs/design-standard-console-rail.md): 13px sans for everything, one
 * 20px/500 title (the preview name), weight at most 500, no tracked mono
 * caps, 28px controls, and selection drawn as a background only.
 */
const FILES = [
  "./create-bot.css",
  "./CreateBotFlow.svelte",
  "./KindStep.svelte",
  "./DetailsStep.svelte",
  "./CloudDetailsStep.svelte",
  "./HomeStep.svelte",
  "./RuntimeSignIn.svelte",
  "./BotPreviewCard.svelte",
  "./BotProgressCard.svelte",
];

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function cssOf(rel: string): string {
  const source = read(rel);
  if (rel.endsWith(".css")) return source;
  const start = source.lastIndexOf("<style>");
  return start >= 0 ? source.slice(start) : "";
}

/** Declarations only; comments mention the banned properties by name. */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function rules(css: string): Array<[string, string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
}

describe("create-bot wizard type contract", () => {
  for (const rel of FILES) {
    describe(rel, () => {
      const css = declarations(cssOf(rel));

      it("caps font weight at 500", () => {
        expect(css).not.toMatch(/font-weight:\s*[6-9]\d\d/);
        expect(css).not.toMatch(/font:\s*[6-9]\d\d\s/);
      });

      it("uses no tracked uppercase or mono labels", () => {
        expect(css).not.toMatch(/text-transform:\s*uppercase/);
        expect(css).not.toMatch(/letter-spacing:\s*0?\.\d*[1-9]/);
        // HomeStep keeps mono for the `hq agent enroll` command (code).
        const nonCode = css.replace(/[^{}]*\.external code[^{}]*\{[^}]*\}/g, "");
        expect(nonCode).not.toMatch(/font-mono/);
      });

      it("keeps text at 13px, with 20px only for the preview name", () => {
        const bad: string[] = [];
        for (const [selector, body] of rules(css)) {
          for (const m of body.matchAll(/font(?:-size)?:[^;]*?\b(\d+)px/g)) {
            const px = Number(m[1]);
            if (px === 13) continue;
            if (px === 20 && selector === ".preview-name") continue;
            // Company monogram tiles size their initials to the 24px tile.
            bad.push(`${selector} → ${m[0]}`);
          }
        }
        expect(bad).toEqual([]);
      });

      it("draws selection as a background, not a ring or accent border", () => {
        for (const [selector, body] of rules(css)) {
          if (!/selected|aria-(checked|selected|pressed)="true"|:checked/.test(selector)) continue;
          expect(body, selector).not.toMatch(/box-shadow|border-color|border-left/);
        }
      });

      it("uses no backdrop-filter", () => {
        expect(css).not.toMatch(/backdrop-filter:\s*(?!none)/);
      });
    });
  }

  it("sizes the wizard buttons and fields at the Messages 28px", () => {
    const flow = declarations(cssOf("./CreateBotFlow.svelte"));
    expect(flow).toMatch(/\.flow-primary\s*\{[^}]*height:\s*28px/);
    expect(flow).toMatch(/\.flow-back\s*\{[^}]*height:\s*28px/);
    const shared = declarations(cssOf("./create-bot.css"));
    expect(shared).toMatch(/\.cb-search\s*\{[^}]*height:\s*28px/);
    expect(shared).toMatch(/\.cb-pill\s*\{[^}]*border:\s*0;/);
  });

  it("writes the create shortcut hint in sentence case", () => {
    const flow = read("./CreateBotFlow.svelte");
    expect(flow).not.toContain("TO CREATE");
    expect(flow).toContain("{primaryEnterHint} to create");
  });
});
