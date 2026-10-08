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
  "./NewBotSunriseShell.svelte",
  "./CreateBotFlow.svelte",
  "./LocalScopeStep.svelte",
  "./LocalTemplateStep.svelte",
  "./NewBotExternalStep.svelte",
  "./LocalBotAdvanced.svelte",
  "./CloudDetailsStep.svelte",
  "./HomeStep.svelte",
  "./RuntimeSignIn.svelte",
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
        // Keyboard chords are mono by the design standard (OWNER-D 8).
        const nonCode = css
          .replace(/[^{}]*\.external code[^{}]*\{[^}]*\}/g, "")
          .replace(/[^{}]*\.chord[^{}]*\{[^}]*\}/g, "");
        expect(nonCode).not.toMatch(/font-mono/);
      });

      it("keeps text at 13px, with 20px only for the preview name", () => {
        const bad: string[] = [];
        for (const [selector, body] of rules(css)) {
          for (const m of body.matchAll(/font(?:-size)?:[^;]*?\b(\d+)px/g)) {
            const px = Number(m[1]);
            if (px === 13) continue;
            if (px === 20 && selector === ".preview-name") continue;
            // Keyboard chord: 11px mono, the app-wide chord style.
            if (px === 11 && selector === ".chord") continue;
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

  it("uses the takeover's own buttons and sizes the fields at the Messages 28px", () => {
    // The flow is the takeover's step screens everywhere: its Continue/Create
    // and Back are the takeover's buttons, not a wizard footer of its own.
    const flow = read("./CreateBotFlow.svelte");
    expect(flow).toContain('class="new-bot-create-submit"');
    expect(flow).toContain("<NewBotStepHead");
    expect(declarations(cssOf("./CreateBotFlow.svelte"))).toBe("");
    const shared = declarations(cssOf("./create-bot.css"));
    expect(shared).toMatch(/\.cb-search\s*\{[^}]*height:\s*28px/);
    expect(shared).toMatch(/\.cb-pill\s*\{[^}]*border:\s*0;/);
  });

  it("shows no create shortcut hint: the buttons say what they do and Enter finishes", () => {
    const flow = read("./CreateBotFlow.svelte");
    expect(flow).not.toContain("TO CREATE");
    expect(flow).not.toContain("to create</p>");
    expect(flow).not.toContain("primaryEnterHint");
    expect(flow).not.toContain("<kbd");
  });
});
