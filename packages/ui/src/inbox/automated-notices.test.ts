import { describe, expect, it } from "vitest";

import { automatedAgentJoinNoticeKey } from "./automated-notices";

const AGENT_SENDER = { kind: "dm", fromPersonUid: "agt_01IZZY" };

describe("automatedAgentJoinNoticeKey", () => {
  it("matches the server's current wording — '(an agent)'", () => {
    const key = automatedAgentJoinNoticeKey({
      ...AGENT_SENDER,
      body: "🤖 Izzy (an agent) just joined Indigo.",
    });
    expect(key).toBe("🤖 izzy (an agent) just joined indigo.");
  });

  it("also matches the bot wording — '(a bot)' — so a server copy change does not break grouping", () => {
    const key = automatedAgentJoinNoticeKey({
      ...AGENT_SENDER,
      body: "🤖 Izzy (a bot) just joined Indigo.",
    });
    expect(key).toBe("🤖 izzy (a bot) just joined indigo.");
  });

  it("collapses whitespace and case into one key", () => {
    expect(
      automatedAgentJoinNoticeKey({
        ...AGENT_SENDER,
        body: "  🤖  Izzy   (A BOT)  just joined   Indigo. ",
      }),
    ).toBe("🤖 izzy (a bot) just joined indigo.");
  });

  it("ignores a human quoting the same words", () => {
    expect(
      automatedAgentJoinNoticeKey({
        kind: "dm",
        fromPersonUid: "prs_marcus",
        body: "🤖 Izzy (a bot) just joined Indigo.",
      }),
    ).toBeNull();
  });

  it("trusts legacy rows only via the agents email domain or a matching display name", () => {
    const body = "🤖 Izzy (a bot) just joined Indigo.";
    expect(
      automatedAgentJoinNoticeKey({ kind: "dm", body, fromEmail: "izzy@agents.getindigo.ai" }),
    ).not.toBeNull();
    expect(
      automatedAgentJoinNoticeKey({ kind: "dm", body, fromDisplayName: "Izzy" }),
    ).not.toBeNull();
    expect(
      automatedAgentJoinNoticeKey({ kind: "dm", body, fromDisplayName: "Someone else" }),
    ).toBeNull();
  });

  it("never matches channels, card bodies, or other copy", () => {
    expect(
      automatedAgentJoinNoticeKey({ ...AGENT_SENDER, kind: "channel", body: "🤖 Izzy (a bot) just joined Indigo." }),
    ).toBeNull();
    expect(
      automatedAgentJoinNoticeKey({ ...AGENT_SENDER, body: "🤖 Izzy (a bot) just joined Indigo.", details: "x" }),
    ).toBeNull();
    expect(automatedAgentJoinNoticeKey({ ...AGENT_SENDER, body: "Izzy just joined Indigo." })).toBeNull();
  });
});
