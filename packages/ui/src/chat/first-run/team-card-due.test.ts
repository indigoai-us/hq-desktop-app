// When the "Who do you work with?" card shows under the setup bot's first
// message: from the bot's `team` block, or the host's fallback when an older
// hq-cli sent none and the takeover left the team unsettled.

import { describe, expect, it } from "vitest";

import { messageHasVisibleContent, teamBlockInMessage } from "../messaging/richMessageContent";
import { teamCardAnchorEventId, teamCardDue } from "./team-step";

const BOT = "agt_setup";
const ME = "prs_me";
const withBlock = "Hi there.\n\n```hq-block\n" + JSON.stringify({ v: 1, blocks: [{ kind: "team" }] }) + "\n```";
const due = (messages: { fromPersonUid: string; body: string }[], unsettled: boolean) =>
  teamCardDue(messages, BOT, unsettled, teamBlockInMessage, messageHasVisibleContent);

describe("teamCardDue", () => {
  it("shows from the block when the first message carries it", () => {
    expect(due([{ fromPersonUid: BOT, body: withBlock }], true)).toBe("block");
  });

  it("falls back when the team is unsettled and no block arrived", () => {
    expect(due([{ fromPersonUid: BOT, body: "Hi there." }], true)).toBe("fallback");
  });

  it("never shows once the team is settled", () => {
    expect(due([{ fromPersonUid: BOT, body: "Hi there." }], false)).toBeNull();
    expect(due([{ fromPersonUid: BOT, body: withBlock }], false)).toBeNull();
  });

  it("goes away once the person writes", () => {
    expect(due([{ fromPersonUid: BOT, body: "Hi there." }, { fromPersonUid: ME, body: "Joined Acme" }], true)).toBeNull();
  });

  it("waits for the bot's first message", () => {
    expect(due([], true)).toBeNull();
  });
});

const anchor = (messages: { eventId?: string; fromPersonUid: string; body: string; richContent?: unknown }[]) =>
  teamCardAnchorEventId(messages, BOT, teamBlockInMessage, messageHasVisibleContent);
const signedOut = {
  eventId: "evt_signed_out",
  fromPersonUid: BOT,
  body: "I couldn't answer because Claude Code is signed out on this Mac. Sign in, then send your message again.",
  richContent: { v: 1, blocks: [{ v: 1, kind: "runtime-repair", class: "signed-out", runtime: "claude", action: "signIn", botName: "setup" }] },
};

describe("teamCardAnchorEventId", () => {
  it("is the opening message that carries the team block", () => {
    const messages = [
      { eventId: "evt_1", fromPersonUid: BOT, body: "Hi." },
      { eventId: "evt_2", fromPersonUid: BOT, body: withBlock },
    ];
    expect(anchor(messages)).toBe("evt_2");
  });

  it("stays on the block message when the bot sends a signed-out reply after it", () => {
    expect(anchor([{ eventId: "evt_team", fromPersonUid: BOT, body: withBlock }, signedOut])).toBe("evt_team");
  });

  it("without a block, is the bot's first visible message, not a later one", () => {
    expect(anchor([{ eventId: "evt_hi", fromPersonUid: BOT, body: "Hi there." }, signedOut])).toBe("evt_hi");
  });

  it("stops at the person's first message, so later bot messages never move it", () => {
    const messages = [
      { eventId: "evt_team", fromPersonUid: BOT, body: withBlock },
      { eventId: "evt_me", fromPersonUid: ME, body: "Just me for now." },
      { eventId: "evt_later", fromPersonUid: BOT, body: withBlock },
    ];
    expect(anchor(messages)).toBe("evt_team");
  });

  it("is null when the person wrote first or nothing has an id", () => {
    expect(anchor([{ eventId: "evt_me", fromPersonUid: ME, body: "hi" }])).toBeNull();
    expect(anchor([{ fromPersonUid: BOT, body: "Hi." }])).toBeNull();
    expect(anchor([])).toBeNull();
    expect(teamCardAnchorEventId([{ eventId: "evt_1", fromPersonUid: BOT, body: "Hi." }], " ", teamBlockInMessage, messageHasVisibleContent)).toBeNull();
  });
});
