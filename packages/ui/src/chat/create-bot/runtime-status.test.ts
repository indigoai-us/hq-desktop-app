/**
 * The three runtime states the wizard used to collapse into "not signed in",
 * and the one rule that made the owner's screenshot possible: a Sign in
 * offered for a CLI that is not on the machine.
 */
import { describe, expect, it } from "vitest";
import {
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

  it("tells a missing CLI where to get it, and never says signed out", () => {
    const footer = runtimeFooter(MISSING, "Claude Code", "claude", true);
    expect(footer.text).toContain("isn’t installed on this Mac");
    expect(footer.text).toContain("claude.ai/download");
    expect(footer.text).not.toContain("signed in");
    expect(footer.actionLabel).toBe("Check again");
    expect(footer.isError).toBe(true);
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
    expect(footer.text).toContain("Signed in on this Mac");
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

  it("gives each blocking state its own sentence", () => {
    expect(runtimeStepIssue(MISSING, "Claude Code")).toBe("Claude Code isn’t installed on this Mac.");
    expect(runtimeStepIssue(FAILED, "Claude Code")).toBe("HQ couldn’t check whether Claude Code is signed in.");
    expect(runtimeStepIssue(SIGNED_OUT, "Claude Code")).toBe("Claude Code is not signed in on this Mac.");
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
});

describe("the sign-in that never opened", () => {
  it("names the runtime and what to do", () => {
    const message = runtimeSignInTimeoutMessage("Claude Code");
    expect(message).toContain("Claude Code");
    expect(message).toContain("didn’t open its sign-in");
    expect(message).toContain("try again");
  });
});
