import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WebKit keeps a NATIVE look on a `<button>` that has not opted out of it,
 * and a natively-drawn control ignores the author's `border` and
 * `background`. The desktop app is WebKit; the design harness is Chromium,
 * which is far more forgiving — so a button that forgets `appearance: none`
 * looks right everywhere we review it and wrong in the only place that
 * ships. The secondary chips on the "Your companies" card lost their
 * hairline exactly this way.
 *
 * Source-level, not rendered: happy-dom does not model native control
 * appearance, so a DOM assertion could not catch this.
 */
const SOURCE = readFileSync(
  resolve("src/chat/messaging/LifecycleCard.svelte"),
  "utf8",
);

/** Every class this component puts on a real `<button>`. */
const BUTTON_CLASSES = ["lc-btn", "lc-seg-btn", "lc-radio"] as const;

function ruleBody(selector: string): string {
  const at = SOURCE.indexOf(`\n  .${selector} {`);
  expect(at, `rule for .${selector}`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n  }", at);
  return SOURCE.slice(at, end);
}

describe("LifecycleCard buttons opt out of native appearance", () => {
  for (const cls of BUTTON_CLASSES) {
    it(`.${cls} resets appearance`, () => {
      const body = ruleBody(cls);
      expect(body).toContain("appearance: none;");
      expect(body).toContain("-webkit-appearance: none;");
    });
  }

  it("covers every button class the markup actually uses", () => {
    const used = new Set(
      [...SOURCE.matchAll(/class="(lc-[a-z-]+)"/g)].map((m) => m[1]),
    );
    const onButtons = [...used].filter((cls) =>
      new RegExp(`<button[^>]*class="${cls}"`, "s").test(SOURCE),
    );
    for (const cls of onButtons) {
      expect(BUTTON_CLASSES, `unguarded button class .${cls}`).toContain(cls);
    }
  });
});
