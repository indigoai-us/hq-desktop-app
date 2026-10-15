// When the "Who do you work with?" card shows under the setup bot's first
// message: from the bot's `team` block, or the host's fallback when an older
// hq-cli sent none and the takeover left the team unsettled.

import { describe, expect, it } from "vitest";

import { messageHasVisibleContent, teamBlockInMessage } from "../messaging/richMessageContent";
import { teamCardDue } from "./team-step";

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
