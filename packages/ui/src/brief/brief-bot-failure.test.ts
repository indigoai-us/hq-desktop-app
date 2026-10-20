import { describe, expect, it } from "vitest";
import { briefBotFailure, type BriefBotMessage } from "./brief-bot-failure.js";

const BOT = "agt_assistant";
const SENT = Date.parse("2026-10-17T01:35:37Z");
const opts = { agentUid: BOT, sinceMs: SENT, bot: "Your assistant", runtime: "claude" };

function repair(cls: string, at = "2026-10-17T01:35:40Z"): BriefBotMessage {
  return {
    fromPersonUid: BOT,
    createdAt: at,
    body: "I couldn't answer that one.",
    richContent: { v: 1, blocks: [{ v: 1, kind: "runtime-repair", class: cls, runtime: "claude", action: "tryAgain", botName: "assistant" }] },
  };
}

describe("briefBotFailure", () => {
  it("turns the bot's failure reply after the send into a plain sentence (owner report, 2026-10-16)", () => {
    expect(briefBotFailure([repair("transient")], opts)).toBe(
      "Your assistant could not start your brief because Claude Code ran into a problem. Try again in a moment.",
    );
  });

  it("names the fix for each failure class, never the tool's own error text", () => {
    expect(briefBotFailure([repair("signed-out")], opts)).toBe(
      "Your assistant is signed out of Claude Code, so it could not make your brief. Sign it in from its messages, then try again.",
    );
    expect(briefBotFailure([repair("cli-outdated")], opts)).toMatch(/needs a newer Claude Code/);
    expect(briefBotFailure([repair("model-unsupported")], opts)).toMatch(/set to a model Claude Code cannot run/);
  });

  it("reads an older CLI's plain failure line and drops the raw error", () => {
    const old: BriefBotMessage = {
      fromPersonUid: BOT,
      createdAt: "2026-10-17T01:35:40Z",
      body: "Sorry — I couldn't answer that one (claude kept failing: error: An unknown error occurred (Unexpected))",
    };
    const said = briefBotFailure([old], opts);
    expect(said).toBe("Your assistant could not start your brief because Claude Code ran into a problem. Try again in a moment.");
    expect(said).not.toMatch(/Unexpected|error:/);
  });

  it("ignores failures from before the send, other senders, and ordinary replies", () => {
    expect(briefBotFailure([repair("transient", "2026-10-17T01:30:00Z")], opts)).toBeNull();
    expect(briefBotFailure([{ ...repair("transient"), fromPersonUid: "prs_owner" }], opts)).toBeNull();
    expect(briefBotFailure([{ fromPersonUid: BOT, createdAt: "2026-10-17T01:36:00Z", body: "On it." }], opts)).toBeNull();
    expect(briefBotFailure([], opts)).toBeNull();
  });
});
