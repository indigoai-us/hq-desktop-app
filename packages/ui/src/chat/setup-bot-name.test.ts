import { describe, expect, it } from "vitest";

import {
  SETUP_BOT_INTRO,
  SETUP_BOT_NAMES,
  pickSetupBotName,
  setupBotIntro,
  setupFinaleOffersSlack,
  setupSlackOfferText,
  takenBotNames,
} from "./setup-bot";
import { messageOffersSlackAgent, parseRichContent } from "./messaging/richMessageContent";

describe("setup bot names", () => {
  it("has 100 distinct names the CLI accepts as a display name", () => {
    expect(SETUP_BOT_NAMES).toHaveLength(100);
    expect(new Set(SETUP_BOT_NAMES.map((n) => n.toLowerCase())).size).toBe(100);
    for (const name of SETUP_BOT_NAMES) expect(name).toMatch(/^[A-Za-z][A-Za-z .'-]{0,34}$/);
  });

  it("never picks a name a bot on the roster already has, whatever the case", () => {
    const taken = takenBotNames(
      [
        { personUid: "agt_1", displayName: "PICKLES" },
        { personUid: "prs_2", displayName: "Biscuit" }, // a person, not a bot: not taken
      ],
      ["mochi"],
    );
    expect(taken.has("pickles")).toBe(true);
    expect(taken.has("biscuit")).toBe(false);
    for (let i = 0; i < 100; i += 1) {
      const picked = pickSetupBotName(taken, () => i / 100);
      expect(["pickles", "mochi"]).not.toContain(picked.toLowerCase());
    }
  });

  it("numbers a name only when every name is taken", () => {
    const all = new Set(SETUP_BOT_NAMES.map((n) => n.toLowerCase()));
    expect(pickSetupBotName(all, () => 0)).toBe(`${SETUP_BOT_NAMES[0]} 2`);
    all.add(`${SETUP_BOT_NAMES[0]!.toLowerCase()} 2`);
    expect(pickSetupBotName(all, () => 0)).toBe(`${SETUP_BOT_NAMES[0]} 3`);
  });

  it("reads contacts wrapped in { contacts } and tolerates junk", () => {
    expect([...takenBotNames({ contacts: [{ uid: "agt_9", name: "Waffles" }, null, 3] })]).toEqual(["waffles"]);
    expect(takenBotNames(null).size).toBe(0);
  });

  it("puts the name in the hello and keeps it under the CLI's 500 characters", () => {
    const longest = [...SETUP_BOT_NAMES].sort((a, b) => b.length - a.length)[0]!;
    const intro = setupBotIntro(longest);
    expect(intro.startsWith(`Hi, I'm ${longest}, your setup bot`)).toBe(true);
    expect(intro.length).toBeLessThanOrEqual(500);
    expect(setupBotIntro(null)).toBe(SETUP_BOT_INTRO);
  });
});

describe("setup finish Slack offer", () => {
  const done = (slackAgent?: boolean) => ({
    fromPersonUid: "agt_bot",
    body: "",
    richContent: { v: 1, blocks: [{ kind: "setupDone", ...(slackAgent === undefined ? {} : { slackAgent }) }] },
  });

  it("parses slackAgent only when it is literally true", () => {
    expect(parseRichContent({ v: 1, blocks: [{ kind: "setupDone", slackAgent: true }] })?.blocks[0]).toEqual({ kind: "setupDone", slackAgent: true });
    expect(parseRichContent({ v: 1, blocks: [{ kind: "setupDone", slackAgent: "yes" }] })?.blocks[0]).toEqual({ kind: "setupDone" });
  });

  it("offers Slack only when the setup bot's own finish carried the flag", () => {
    expect(setupFinaleOffersSlack([done(true)], "agt_bot", messageOffersSlackAgent)).toBe(true);
    expect(setupFinaleOffersSlack([done()], "agt_bot", messageOffersSlackAgent)).toBe(false);
    expect(setupFinaleOffersSlack([{ ...done(true), fromPersonUid: "agt_other" }], "agt_bot", messageOffersSlackAgent)).toBe(false);
  });

  it("names the bot in the button and in the message it sends", () => {
    expect(setupSlackOfferText("Pickles")).toBe("Put Pickles in Slack");
    expect(setupSlackOfferText(null)).toBe("Put my setup bot in Slack");
  });
});
