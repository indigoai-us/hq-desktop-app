// Contract for the owner's Messages type exception (AUDIT-2-06): every exempt
// element still declares exactly the recorded size and weight, and the design
// standard lists every one, so audits read the exception instead of flagging it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGES_TYPE_EXCEPTIONS } from "./messages-type-exception";

const src = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const standard = readFileSync(
  new URL("../../../../docs/design-standard-console-rail.md", import.meta.url),
  "utf8",
);

function rule(source: string, selector: string): string | undefined {
  const start = source.lastIndexOf("<style");
  const css = (start >= 0 ? source.slice(start) : source).replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const last = sel.trim().split("\n").pop()?.trim();
    if (last === selector) return body;
  }
  return undefined;
}

describe("Messages type exception (AUDIT-2-06)", () => {
  it("the design standard records the exception", () => {
    expect(standard).toMatch(/## Messages type exception \(AUDIT-2-06\)/);
  });

  for (const ex of MESSAGES_TYPE_EXCEPTIONS) {
    const label = `${ex.file} ${ex.selector}`;
    it(`${label} is listed in the design standard`, () => {
      const section = standard.split("## Messages type exception")[1] ?? "";
      expect(section).toContain(`\`${ex.selector}\``);
    });

    it(`${label} keeps its recorded type`, () => {
      const body = rule(src(ex.file), ex.selector);
      expect(body, `${label} rule exists`).toBeDefined();
      if (ex.fontSize) {
        expect(body).toMatch(new RegExp(`font-size:\\s*${ex.fontSize}`));
      }
      if (ex.fontWeight) {
        expect(body).toMatch(new RegExp(`font-weight:\\s*${ex.fontWeight}`));
      }
    });
  }
});
