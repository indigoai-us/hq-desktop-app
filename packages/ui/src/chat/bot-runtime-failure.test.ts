import { describe, expect, it } from "vitest";

import { isRawBotFailureText } from "./local-bots";
import {
  botNeedsCodingToolNotice,
  localBotNeedsCodingTool,
  plainBotFailureReply,
  withPlainBotFailureReplies,
} from "./bot-runtime-failure";

// The replies hq-cli (src/lib/bot/run.ts) posts when a model turn fails, as a
// freshly wiped Mac with no Claude Code received them.
const EM = "\u2014";
const KEPT_FAILING_MISSING = `Sorry ${EM} I couldn't answer that one (claude kept failing: claude is not installed or not on PATH). Try again in a bit, or check that claude is signed in on this computer.`;
const RUN_FAILED_MISSING = `I couldn't run this one ${EM} codex kept failing: spawn codex ENOENT.`;
const KICKOFF_MISSING = `Sorry ${EM} I couldn't get started on my own (claude failed: claude is not installed or not on PATH). Send me any message and I'll pick up from there, or check that claude is signed in on this computer.`;
const KEPT_FAILING_OTHER = `Sorry ${EM} I couldn't answer that one (claude kept failing: API Error: 529 overloaded_error). Try again in a bit, or check that claude is signed in on this computer.`;

describe("plainBotFailureReply", () => {
  it("turns a missing-runtime reply into a plain sentence with the fix", () => {
    const plain = plainBotFailureReply(KEPT_FAILING_MISSING, { noun: "Mac" });
    expect(plain).toEqual({
      body: "I couldn't answer because Claude Code isn't installed on this Mac. Install it and sign in, then send your message again.",
      runtimeMissing: true,
    });
    expect(plain!.body).not.toContain("PATH");
    expect(plain!.body).not.toContain("kept failing");
    expect(isRawBotFailureText(plain!.body)).toBe(false);
  });

  it("covers the run and kickoff failure replies too", () => {
    expect(plainBotFailureReply(RUN_FAILED_MISSING, { noun: "Mac" })?.body).toBe(
      "I couldn't answer because Codex isn't installed on this Mac. Install it and sign in, then send your message again.",
    );
    expect(plainBotFailureReply(KICKOFF_MISSING)?.runtimeMissing).toBe(true);
  });

  it("drops the quoted error for other failures, and does not blame sign-in for them", () => {
    const plain = plainBotFailureReply(KEPT_FAILING_OTHER, { noun: "PC" });
    expect(plain).toEqual({
      body: "I couldn't answer that one because Claude Code ran into a problem. Try again in a bit.",
      runtimeMissing: false,
    });
    expect(plain!.body).not.toContain("529");
    expect(plain!.body).not.toMatch(/sign/i);
  });

  it("never tells the person to sign in when Codex is only too old for its model (owner, 2026-10-10)", () => {
    const tooOld = `Sorry ${EM} I couldn't answer that one (codex kept failing: The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.). Try again in a bit, or check that codex is signed in on this computer.`;
    const plain = plainBotFailureReply(tooOld, { noun: "Mac" });
    expect(plain!.body).toBe("I couldn't answer that one because Codex ran into a problem. Try again in a bit.");
    expect(plain!.body).not.toMatch(/sign/i);
  });

  it("names sign-in only when the tool's error is a sign-in problem", () => {
    for (const detail of ["Not logged in. Please run /login", "API Error: 401 Unauthorized", "Your session has expired, sign in again"]) {
      const plain = plainBotFailureReply(`Sorry ${EM} I couldn't answer that one (claude kept failing: ${detail}).`, { noun: "Mac" });
      expect(plain!.body).toBe("I couldn't answer because Claude Code is signed out on this Mac. Sign in, then send your message again.");
      expect(plain!.body).not.toContain(detail);
    }
  });

  it("keeps a reply that carries a runtime repair block as the bot wrote it", () => {
    const repair = {
      fromPersonUid: "agt_scout",
      body: "Codex on this Mac is too old for the model I'm set to. Update it, then send your message again.",
      richContent: { v: 1, blocks: [{ v: 1, kind: "runtime-repair", class: "cli-outdated", runtime: "codex", action: "update", botName: "scout" }] },
    };
    const legacy = { fromPersonUid: "agt_scout", body: KEPT_FAILING_OTHER };
    const out = withPlainBotFailureReplies([repair, legacy]);
    expect(out[0]).toBe(repair);
    expect(out[1]!.body).not.toBe(KEPT_FAILING_OTHER);
  });

  it("leaves ordinary bot messages alone", () => {
    expect(plainBotFailureReply("Hi, I'm Taffy. What kind of business do you run?")).toBeNull();
    expect(plainBotFailureReply("")).toBeNull();
    expect(plainBotFailureReply(null)).toBeNull();
  });
});

describe("withPlainBotFailureReplies", () => {
  it("rewrites bot failure replies and keeps everything else", () => {
    const messages = [
      { eventId: "1", fromPersonUid: "prs_me", body: "hey friend" },
      { eventId: "2", fromPersonUid: "agt_taffy", body: KEPT_FAILING_MISSING },
      { eventId: "3", fromPersonUid: "agt_taffy", body: "All set." },
    ];
    const shown = withPlainBotFailureReplies(messages, { noun: "Mac" });
    expect(shown.map((m) => m.body)).toEqual([
      "hey friend",
      "I couldn't answer because Claude Code isn't installed on this Mac. Install it and sign in, then send your message again.",
      "All set.",
    ]);
    expect(shown[1]!.eventId).toBe("2");
    expect(JSON.stringify(shown)).not.toContain("not on PATH");
  });

  it("does not rewrite a person quoting the failure", () => {
    const messages = [{ eventId: "1", fromPersonUid: "prs_me", body: KEPT_FAILING_MISSING }];
    expect(withPlainBotFailureReplies(messages)).toBe(messages);
  });

  it("returns the same array when nothing changed", () => {
    const messages = [{ eventId: "1", fromPersonUid: "agt_taffy", body: "hello" }];
    expect(withPlainBotFailureReplies(messages)).toBe(messages);
  });
});

describe("localBotNeedsCodingTool", () => {
  it("is true only once the host has said the bot's tool is not ready", () => {
    const bot = { runtime: "claude" as const };
    expect(localBotNeedsCodingTool(bot, { claude: false, codex: false, grok: false })).toBe(true);
    expect(localBotNeedsCodingTool(bot, { claude: true, codex: false, grok: false })).toBe(false);
    expect(localBotNeedsCodingTool(bot, null)).toBe(false);
    expect(localBotNeedsCodingTool(null, { claude: false })).toBe(false);
  });

  it("names the bot and its tool in the notice", () => {
    expect(
      botNeedsCodingToolNotice({ name: "setup", displayName: "Taffy", runtime: "claude" }, { noun: "Mac" }),
    ).toBe("Taffy needs Claude Code on this Mac to answer. Install it and sign in here, and Taffy picks up from there.");
  });
});
