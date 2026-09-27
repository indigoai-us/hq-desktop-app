/**
 * Regression: the operator saw "No coding tool is signed in on this Mac yet"
 * on a Windows setup bot (US-006). The class of the bug is any setup /
 * onboarding string that names "Mac" or "macOS" while rendering on a Windows
 * host.
 *
 * This test asserts the platform-neutrality of the exported setup copy that
 * the setup bot, its cards and its install prompts consume. Any regression
 * that lands a Mac-named string back into these exports fails here.
 *
 * The onboarding-wizard subtitle carries the platform-aware "this may take
 * longer on Windows" line and is covered by
 * `apps/sync/src/lib/onboarding-platform.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  SETUP_BOT_COPY,
  SETUP_BOT_INTRO,
  SETUP_BOT_KICKOFF,
  SETUP_BOT_NO_RUNTIME,
  SETUP_BOT_ALREADY_ELSEWHERE,
  SETUP_BOT_GENERIC_FAILURE,
  SETUP_BOT_UNAVAILABLE,
  SETUP_ELSEWHERE_COPY,
} from "./setup-bot";
import { SETUP_RUN_PERMISSION } from "./setup-run";
import { SETUP_HERO_RETURNING } from "./setup-channel";

/**
 * Match `Mac`, `Macs`, `macOS` as whole words, case-insensitive. Deliberately
 * excludes internal substrings such as "Machine" or "Macedonia".
 */
const MAC_NAMED = /\bmac(os|s)?\b/i;

function assertNeutral(label: string, value: unknown): void {
  if (typeof value !== "string") return;
  if (MAC_NAMED.test(value)) {
    throw new Error(
      `${label} names "Mac" in copy that a Windows setup bot also renders: ${JSON.stringify(value)}`,
    );
  }
}

describe("setup exports are platform-neutral (US-006 regression)", () => {
  it("SETUP_BOT_INTRO never says 'Mac' — a Windows setup bot sends the same intro", () => {
    assertNeutral("SETUP_BOT_INTRO", SETUP_BOT_INTRO);
  });

  it("SETUP_BOT_KICKOFF never says 'Mac' — the bot's kickoff runs on every platform", () => {
    assertNeutral("SETUP_BOT_KICKOFF", SETUP_BOT_KICKOFF);
  });

  it("SETUP_BOT_COPY.* — the hero, card body, starting and body strings — never say 'Mac'", () => {
    for (const [key, value] of Object.entries(SETUP_BOT_COPY)) {
      assertNeutral(`SETUP_BOT_COPY.${key}`, value);
    }
  });

  it("SETUP_BOT_NO_RUNTIME — the exact string the operator flagged on Windows — is now platform-neutral", () => {
    assertNeutral("SETUP_BOT_NO_RUNTIME", SETUP_BOT_NO_RUNTIME);
    // Positive check on the wording, not just its absence.
    expect(SETUP_BOT_NO_RUNTIME).toContain("this computer");
  });

  it("SETUP_BOT_ALREADY_ELSEWHERE, SETUP_BOT_GENERIC_FAILURE and SETUP_BOT_UNAVAILABLE are neutral", () => {
    assertNeutral("SETUP_BOT_ALREADY_ELSEWHERE", SETUP_BOT_ALREADY_ELSEWHERE);
    assertNeutral("SETUP_BOT_GENERIC_FAILURE", SETUP_BOT_GENERIC_FAILURE);
    assertNeutral("SETUP_BOT_UNAVAILABLE", SETUP_BOT_UNAVAILABLE);
  });

  it("SETUP_ELSEWHERE_COPY.* is neutral (Claude Code / Codex still named, but no OS)", () => {
    for (const [key, value] of Object.entries(SETUP_ELSEWHERE_COPY)) {
      assertNeutral(`SETUP_ELSEWHERE_COPY.${key}`, value);
    }
  });

  it("SETUP_RUN_PERMISSION.* is neutral — the permission card renders on Windows too", () => {
    for (const [key, value] of Object.entries(SETUP_RUN_PERMISSION)) {
      assertNeutral(`SETUP_RUN_PERMISSION.${key}`, value);
    }
  });

  it("SETUP_HERO_RETURNING.* is neutral — the returning-user hero renders on Windows too", () => {
    for (const [key, value] of Object.entries(SETUP_HERO_RETURNING)) {
      assertNeutral(`SETUP_HERO_RETURNING.${key}`, value);
    }
  });
});
