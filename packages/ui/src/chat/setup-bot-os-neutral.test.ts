/**
 * Regression: the operator saw "No coding tool is signed in on this Mac yet"
 * on a Windows setup bot (US-006). The class of the bug is any setup /
 * onboarding string that names "Mac" on a Windows host, or "PC" on a Mac.
 *
 * The setup copy is now OS-aware: every affected export is a function that
 * takes the plain-language host noun ("Mac", "PC", or "computer" from
 * `hostComputerNoun`). This test locks two things down:
 *
 * 1. Under a macOS probe, no setup or onboarding string renders "PC".
 * 2. Under a Windows probe, no setup or onboarding string renders "Mac".
 * 3. With no noun (probe not ready / unknown OS), the neutral "computer"
 *    wording is used - never a guess.
 *
 * The onboarding-wizard subtitle carries the platform-aware "this may take
 * longer on Windows" line and is covered by
 * `apps/sync/src/lib/onboarding-platform.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  setupBotCopy,
  setupBotIntro,
  setupBotKickoff,
  setupBotNoRuntime,
  SETUP_BOT_ALREADY_ELSEWHERE,
  SETUP_BOT_GENERIC_FAILURE,
  SETUP_BOT_UNAVAILABLE,
  SETUP_ELSEWHERE_COPY,
} from "./setup-bot";
import { setupRunPermission } from "./setup-run";
import { setupHeroReturning } from "./setup-channel";

/** Match `Mac`, `Macs`, `macOS` as whole words, case-insensitive. */
const MAC_NAMED = /\bmac(os|s)?\b/i;
/** Match `PC` or `PCs` as whole words. */
const PC_NAMED = /\bPCs?\b/;

interface OsExpectation {
  osLabel: string;
  noun: string;
  /** Whole-word regex the rendered copy MUST contain. */
  expects: RegExp;
  /** Substring the rendered copy must NOT contain (the wrong OS name). */
  forbids: RegExp;
}

const AFFECTED_STRINGS: ReadonlyArray<{ label: string; render: (opts: { noun?: string }) => string }> = [
  { label: "setupBotIntro", render: (o) => setupBotIntro(o) },
  { label: "setupBotKickoff", render: (o) => setupBotKickoff(o) },
  { label: "setupBotCopy.cardBody", render: (o) => setupBotCopy(o).cardBody },
  { label: "setupBotCopy.bodyStarting", render: (o) => setupBotCopy(o).bodyStarting },
  { label: "setupBotCopy.body", render: (o) => setupBotCopy(o).body },
  { label: "setupBotNoRuntime", render: (o) => setupBotNoRuntime(o) },
  { label: "setupRunPermission.text", render: (o) => setupRunPermission(o).text },
  { label: "setupHeroReturning.body", render: (o) => setupHeroReturning(o).body },
];

const CASES: OsExpectation[] = [
  { osLabel: "macOS", noun: "Mac", expects: /\bMac\b/, forbids: PC_NAMED },
  { osLabel: "Windows", noun: "PC", expects: /\bPC\b/, forbids: MAC_NAMED },
];

describe("setup copy is OS-aware (US-006 regression, extended for OS-specific wording)", () => {
  for (const c of CASES) {
    for (const s of AFFECTED_STRINGS) {
      it(`${s.label} names ${c.noun} on ${c.osLabel} and never the wrong OS`, () => {
        const rendered = s.render({ noun: c.noun });
        expect(rendered, `${s.label} on ${c.osLabel}: expected to name ${c.noun}`).toMatch(c.expects);
        if (c.forbids.test(rendered)) {
          throw new Error(`${s.label} on ${c.osLabel} contains the wrong OS name: ${JSON.stringify(rendered)}`);
        }
      });
    }
  }

  for (const s of AFFECTED_STRINGS) {
    it(`${s.label} falls back to neutral "computer" when the probe is not ready`, () => {
      // Both an absent noun and an unknown probe must produce the same
      // neutral wording. Never guesses "Mac" or "PC".
      const missing = s.render({});
      const empty = s.render({ noun: "" });
      const whitespace = s.render({ noun: "   " });
      for (const rendered of [missing, empty, whitespace]) {
        expect(rendered).toContain("computer");
        expect(rendered).not.toMatch(MAC_NAMED);
        expect(rendered).not.toMatch(PC_NAMED);
      }
    });
  }

  it("static copy that has no OS-dependent word stays platform-neutral", () => {
    for (const [key, value] of Object.entries(SETUP_ELSEWHERE_COPY)) {
      if (typeof value !== "string") continue;
      expect(value, `SETUP_ELSEWHERE_COPY.${key}`).not.toMatch(MAC_NAMED);
      expect(value, `SETUP_ELSEWHERE_COPY.${key}`).not.toMatch(PC_NAMED);
    }
    for (const [label, value] of [
      ["SETUP_BOT_ALREADY_ELSEWHERE", SETUP_BOT_ALREADY_ELSEWHERE],
      ["SETUP_BOT_GENERIC_FAILURE", SETUP_BOT_GENERIC_FAILURE],
      ["SETUP_BOT_UNAVAILABLE", SETUP_BOT_UNAVAILABLE],
    ] as const) {
      expect(value, label).not.toMatch(MAC_NAMED);
      expect(value, label).not.toMatch(PC_NAMED);
    }
  });

  it("setupBotIntro carries the display name through the OS-aware substitution", () => {
    const rendered = setupBotIntro({ noun: "PC", displayName: "Pickles" });
    expect(rendered).toContain("Hi, I'm Pickles, your setup bot");
    expect(rendered).toContain("your PC");
    expect(rendered).not.toMatch(MAC_NAMED);
  });
});
