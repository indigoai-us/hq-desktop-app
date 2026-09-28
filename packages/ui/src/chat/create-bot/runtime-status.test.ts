/**
 * The three runtime states the wizard used to collapse into "not signed in",
 * and the one rule that made the owner's screenshot possible: a Sign in
 * offered for a CLI that is not on the machine.
 */
import { describe, expect, it } from "vitest";
import {
  dedupeSearchedDirs,
  parseRuntimeStatus,
  runtimeBlocksNext,
  runtimeCanSignIn,
  runtimeChipSuffix,
  runtimeFooter,
  runtimeSignInTimeoutMessage,
  runtimeStatusOf,
  runtimeStepIssue,
  type RuntimeStatus,
} from "./runtime-status.js";

const SIGNED_IN: RuntimeStatus = { state: "signedIn" };
const SIGNED_OUT: RuntimeStatus = { state: "signedOut" };
const MISSING: RuntimeStatus = { state: "notInstalled", searched: ["/opt/homebrew/bin"] };
const FAILED: RuntimeStatus = { state: "probeFailed", reason: "it did not answer in time" };

describe("chip labels", () => {
  it("names each state differently", () => {
    expect(runtimeChipSuffix(SIGNED_IN)).toBe("");
    expect(runtimeChipSuffix(SIGNED_OUT)).toBe(" · not signed in");
    expect(runtimeChipSuffix(MISSING)).toBe(" · not installed");
    expect(runtimeChipSuffix(FAILED)).toBe(" · couldn’t check");
  });

  it("says nothing extra when the host has no status", () => {
    expect(runtimeChipSuffix(null)).toBe("");
  });
});

describe("what the footer offers", () => {
  it("offers Sign in only when the CLI was found", () => {
    expect(runtimeFooter(SIGNED_OUT, "Claude Code", "claude", true).action).toBe("signin");
    expect(runtimeFooter(MISSING, "Claude Code", "claude", true).action).toBe("retry");
    expect(runtimeFooter(FAILED, "Claude Code", "claude", true).action).toBe("retry");
    expect(runtimeFooter(SIGNED_IN, "Claude Code", "claude", true).action).toBeNull();
  });

  it("tells a missing CLI where to get it, in plain words, and never repeats 'signed in'", () => {
    const footer = runtimeFooter(MISSING, "Claude Code", "claude", true);
    expect(footer.text).toContain("isn’t installed on this computer");
    // The hint must NOT send a non-technical person to a terminal — the
    // operator's rule. It reads as "HQ can install it for you and walk you
    // through signing in.", pinned per-tool. See INSTALL_HINT.
    expect(footer.text).not.toMatch(/\bnpm\b/i);
    expect(footer.text).not.toMatch(/\bCLI\b/);
    expect(footer.text).not.toMatch(/\bterminal\b/i);
    expect(footer.text).not.toMatch(/claude\.ai\/download/i);
    expect(footer.text).toContain("HQ can install it for you");
    expect(footer.text).not.toContain("signed in on");
    expect(footer.actionLabel).toBe("Check again");
    expect(footer.isError).toBe(true);
  });

  it("after install and before sign-in, the signed-out arm says 'is installed. Sign in to finish.'", () => {
    // Problem 1 (verify-install-003 follow-up): once a fresh install lands
    // and the runtime status flips to `signedOut`, the panel must confirm
    // the install worked and point to the next step. Before the fix, the
    // person read "Claude Code is not signed in on this Mac." — the panel
    // read as though nothing had happened.
    const footer = runtimeFooter(SIGNED_OUT, "Claude Code", "claude", true, "PC");
    expect(footer.text).toBe("Claude Code is installed. Sign in to finish.");
    expect(footer.action).toBe("signin");
    expect(footer.isError).toBe(false);
  });

  it("names the reason a check failed, and offers a retry", () => {
    const footer = runtimeFooter(FAILED, "Claude Code", "claude", true);
    expect(footer.text).toBe("Couldn’t check Claude Code — it did not answer in time.");
    expect(footer.actionLabel).toBe("Try again");
    expect(footer.isError).toBe(true);
  });

  it("drops the reason clause when there is none", () => {
    expect(runtimeFooter({ state: "probeFailed" }, "Grok", "grok", true).text).toBe("Couldn’t check Grok.");
  });

  it("falls back to Settings when the host wired no sign-in at all", () => {
    const footer = runtimeFooter(SIGNED_OUT, "Codex", "codex", false);
    expect(footer.action).toBeNull();
    expect(footer.text).toContain("Settings → AI tools");
  });

  it("is a plain confirmation when signed in", () => {
    const footer = runtimeFooter(SIGNED_IN, "Codex", "codex", true);
    expect(footer.text).toContain("Signed in on this computer");
    expect(footer.isError).toBe(false);
  });
});

describe("gating", () => {
  it("only lets a signed-in runtime through", () => {
    expect(runtimeBlocksNext(SIGNED_IN)).toBe(false);
    expect(runtimeBlocksNext(SIGNED_OUT)).toBe(true);
    expect(runtimeBlocksNext(MISSING)).toBe(true);
    expect(runtimeBlocksNext(FAILED)).toBe(true);
  });

  it("never blocks on a status the host did not report", () => {
    expect(runtimeBlocksNext(null)).toBe(false);
  });

  it("refuses to open a sign-in for a CLI that is not here", () => {
    expect(runtimeCanSignIn(MISSING)).toBe(false);
    expect(runtimeCanSignIn(SIGNED_OUT)).toBe(true);
    expect(runtimeCanSignIn(SIGNED_IN)).toBe(true);
    expect(runtimeCanSignIn(null)).toBe(true);
    // A probe that could not answer may still hold a working CLI, but the
    // honest next step is another check, not a browser flow.
    expect(runtimeCanSignIn(FAILED)).toBe(false);
  });

  it("points the flow-issue footer to the panel above, never repeating the panel's own text", () => {
    // Problem 3 (verify-install-003 follow-up): the wizard's flow-issue
    // footer used to read "Claude Code isn't installed on this computer."
    // right next to Next while the panel above already said the same thing
    // in different words. Keep ONE message: the panel is the primary
    // surface, and the footer's job is to say why Next is disabled without
    // contradicting the panel.
    expect(runtimeStepIssue(MISSING, "Claude Code")).toBe("Finish setting up Claude Code above.");
    expect(runtimeStepIssue(FAILED, "Claude Code")).toBe("HQ couldn’t check whether Claude Code is signed in.");
    expect(runtimeStepIssue(SIGNED_OUT, "Claude Code")).toBe("Sign in to Claude Code above.");
    expect(runtimeStepIssue(SIGNED_IN, "Claude Code")).toBeNull();
    expect(runtimeStepIssue(null, "Claude Code")).toBeNull();
  });
});

describe("reading the host's payload", () => {
  it("parses every arm the backend serializes", () => {
    expect(parseRuntimeStatus({ state: "signedIn" })).toEqual(SIGNED_IN);
    expect(parseRuntimeStatus({ state: "signedOut" })).toEqual(SIGNED_OUT);
    expect(parseRuntimeStatus({ state: "notInstalled", searched: ["/a", 2, "/b"] })).toEqual({
      state: "notInstalled",
      searched: ["/a", "/b"],
    });
    expect(parseRuntimeStatus({ state: "probeFailed", reason: "it timed out" })).toEqual({
      state: "probeFailed",
      reason: "it timed out",
    });
  });

  it("treats anything it does not recognise as no status at all", () => {
    for (const raw of [null, undefined, 3, "signedIn", {}, { state: "whatever" }]) {
      expect(parseRuntimeStatus(raw)).toBeNull();
    }
  });

  it("reads a runtime out of the map, and null when it is absent", () => {
    const map = { claude: SIGNED_OUT };
    expect(runtimeStatusOf(map, "claude")).toEqual(SIGNED_OUT);
    expect(runtimeStatusOf(map, "codex")).toBeNull();
    expect(runtimeStatusOf(null, "claude")).toBeNull();
  });

  it("strips repeats out of the searched list so the keyed list can never crash", () => {
    // The exact shape a 64-bit Windows machine produced before this fix:
    // ProgramFiles and ProgramW6432 both resolved to the same folder, so
    // `searched` came out with an identical entry twice and the Home step
    // threw `svelte.dev/e/each_key_duplicate`.
    const parsed = parseRuntimeStatus({
      state: "notInstalled",
      searched: [
        "C:\\Program Files\\nodejs",
        "C:\\Program Files\\nodejs",
        "C:\\program files\\nodejs",
        "C:\\Program Files\\nodejs\\",
        "C:\\Program Files (x86)\\nodejs",
      ],
    });
    expect(parsed?.state).toBe("notInstalled");
    expect((parsed as unknown as { searched: string[] }).searched).toEqual([
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
    ]);
  });
});

describe("dedupeSearchedDirs (belt-and-braces for the keyed each block)", () => {
  it("drops case-only and trailing-separator repeats but keeps distinct folders in order", () => {
    expect(
      dedupeSearchedDirs([
        "C:\\Program Files\\nodejs",
        "C:\\program files\\nodejs",
        "C:\\Program Files\\nodejs\\",
        "C:\\Program Files (x86)\\nodejs",
      ]),
    ).toEqual(["C:\\Program Files\\nodejs", "C:\\Program Files (x86)\\nodejs"]);
  });

  it("returns the same list when there are no repeats", () => {
    const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.local/bin"];
    expect(dedupeSearchedDirs(dirs)).toEqual(dirs);
  });

  it("returns an empty array for an empty input", () => {
    expect(dedupeSearchedDirs([])).toEqual([]);
  });
});

describe("OS-aware wording (US-006 extension)", () => {
  it("names the machine 'Mac' on macOS in the runtimeFooter arms that carry a noun", () => {
    // The `notInstalled` footer intentionally reads "…isn't installed on this
    // <host>." and picks up the host name.
    expect(runtimeFooter(MISSING, "Claude Code", "claude", true, "Mac").text).toContain("on this Mac");
    // The `signedIn` footer says "Signed in on this Mac".
    expect(runtimeFooter(SIGNED_IN, "Grok", "grok", true, "Mac").text).toContain("Signed in on this Mac");
    // The `signedOut` footer now says "is installed. Sign in to finish." and
    // does NOT carry the host name (the panel above owns the machine name).
    expect(runtimeFooter(SIGNED_OUT, "Codex", "codex", true, "Mac").text).toBe(
      "Codex is installed. Sign in to finish.",
    );
  });

  it("names the machine 'PC' on Windows and never says 'Mac' in the notInstalled/signedIn arms", () => {
    // These two arms still carry the host name.
    for (const status of [MISSING, SIGNED_IN]) {
      const footer = runtimeFooter(status, "Claude Code", "claude", true, "PC");
      expect(footer.text).toContain("this PC");
      expect(footer.text).not.toMatch(/\bMac\b/);
    }
    // signedOut does not carry a host name at all now (see the Problem 1
    // wording fix above), so noun-independence is asserted directly.
    const signedOutFooter = runtimeFooter(SIGNED_OUT, "Codex", "codex", true, "PC");
    expect(signedOutFooter.text).not.toMatch(/\bMac\b/);
    // The flow-issue footer no longer names the machine either (Problem 3):
    // it points to the panel above, in the same plain wording regardless
    // of OS.
    expect(runtimeStepIssue(MISSING, "Claude Code", "PC")).toBe("Finish setting up Claude Code above.");
    expect(runtimeStepIssue(SIGNED_OUT, "Codex", "PC")).toBe("Sign in to Codex above.");
  });

  it("falls back to neutral 'computer' when the probe is not ready", () => {
    // Missing arg, empty string, and whitespace all resolve to the same
    // neutral wording so a Windows user never briefly reads "Mac".
    for (const noun of [undefined, "", "   "]) {
      const footer = runtimeFooter(MISSING, "Claude Code", "claude", true, noun as string | undefined);
      expect(footer.text).toContain("on this computer");
      expect(footer.text).not.toMatch(/\bMac\b/);
      expect(footer.text).not.toMatch(/\bPC\b/);
    }
    // signedOut wording is host-agnostic after the Problem 1 fix.
    expect(runtimeStepIssue(SIGNED_OUT, "Codex", undefined as unknown as string)).toBe("Sign in to Codex above.");
  });
});

describe("the sign-in that never opened", () => {
  it("names the runtime and what to do", () => {
    const message = runtimeSignInTimeoutMessage("Claude Code");
    expect(message).toContain("Claude Code");
    expect(message).toContain("didn’t open its sign-in");
    expect(message).toContain("try again");
  });
});
