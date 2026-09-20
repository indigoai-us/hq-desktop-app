/**
 * personal-bot-channel-scope, client side.
 *
 * A personal bot belongs to one person. Other people can reach it only inside a
 * channel its OWNER added it to — so the pickers must never offer somebody
 * else's personal bot, and the one place a teammate's bot may legitimately
 * appear is the open channel's roster.
 *
 * The server is the authority (hq-pro-core notify-dm answers
 * PERSONAL_BOT_OWNER_ONLY); these tests lock the client contract that decides
 * what a person is offered in the first place, and how the refusal reads when
 * they get there anyway.
 */

import { describe, expect, it } from "vitest";

import type { LocalBotRow } from "@hq/platform";
import { localBotsAsContacts } from "./local-bots.js";
import { buildPickerCandidates, memberFailureReason } from "./create-flow.js";
import { mentionTargetsFromContacts } from "./mentions.js";
import {
  formatComposerSendError,
  isMentionSendError,
  isTerminalSendError,
} from "./messaging/composer-send-error.js";

const ME = "prs_me";
const MY_BOT = "agt_01MYBOT0000000000000000000";
const THEIR_BOT = "agt_01THEIRBOT00000000000000";

function bot(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "george",
    agentUid: MY_BOT,
    ownerUid: ME,
    runtime: "claude",
    state: "stopped",
    pid: null,
    processAlive: false,
    online: false,
    lastHeartbeatAt: null,
    daemonInstalled: false,
    daemonLoaded: false,
    dir: "/tmp/george",
    kind: "personal",
    ...over,
  } as LocalBotRow;
}

describe("the pickers only ever carry MY personal bots", () => {
  it("injects my own local bots as contacts", () => {
    const out = localBotsAsContacts([], [bot()]);
    expect(out).toEqual([{ personUid: MY_BOT, displayName: "george", companyUid: null }]);
  });

  it("has no way to inject a bot I do not own — the list is my own bots", () => {
    // `localBots` is this Mac's own bot listing, so a teammate's personal bot
    // can never enter through here. With no bots of my own, the picker source
    // is exactly the server contacts roster, which carries no personal bots
    // (they hold no company membership).
    const contacts = [{ personUid: "prs_mate", displayName: "Mate" }];
    expect(localBotsAsContacts(contacts, [])).toEqual(contacts);
    expect(localBotsAsContacts(contacts, null)).toEqual(contacts);
  });

  it("does not duplicate a bot the server roster already listed", () => {
    const contacts = [{ personUid: MY_BOT, displayName: "george" }];
    expect(localBotsAsContacts(contacts, [bot()])).toEqual(contacts);
  });

  it("a teammate's personal bot is not offered in the channel-member picker", () => {
    const candidates = buildPickerCandidates({
      rows: [],
      contacts: localBotsAsContacts([], [bot()]),
      query: "george",
      picked: [],
      selfPersonUid: ME,
      allowEmail: false,
    } as never) as ReadonlyArray<{ personUid?: string }>;
    const uids = candidates.map((c) => c.personUid);
    expect(uids).toContain(MY_BOT);
    expect(uids).not.toContain(THEIR_BOT);
  });
});

describe("a teammate's personal bot on the open channel's roster", () => {
  it("is mentionable under its real name once its owner added it", () => {
    const targets = mentionTargetsFromContacts([
      { personUid: THEIR_BOT, displayName: "george" },
    ]);
    expect(targets).toEqual([
      { participantUid: THEIR_BOT, participantType: "agent", displayName: "george" },
    ]);
  });

  it("falls back to a uid label only when the roster row carries no name", () => {
    const [target] = mentionTargetsFromContacts([{ personUid: THEIR_BOT, displayName: "" }]);
    expect(target?.displayName).toMatch(/^Bot /);
  });
});

describe("the server's PERSONAL_BOT_OWNER_ONLY refusal", () => {
  it("maps an add-member failure to the personal-bot reason", () => {
    expect(
      memberFailureReason(new Error("[PERSONAL_BOT_OWNER_ONLY] nope"), THEIR_BOT),
    ).toBe("personal-bot");
  });

  it("does not disturb the existing add-member reasons", () => {
    expect(memberFailureReason(new Error("CHANNEL_NOT_OWNER"), "prs_mate")).toBe("not-owner");
    expect(memberFailureReason(new Error("RECIPIENT_NOT_FOUND"), THEIR_BOT)).toBe("agent-scope");
    expect(memberFailureReason(new Error("RECIPIENT_NOT_FOUND"), "prs_mate")).toBe("unreachable");
  });

  it("is a terminal send error — retrying from this account cannot help", () => {
    expect(isTerminalSendError("[PERSONAL_BOT_OWNER_ONLY] nope")).toBe(true);
    expect(isMentionSendError("[PERSONAL_BOT_OWNER_ONLY] nope")).toBe(true);
  });

  it("reads as a next step, naming the bot when the message tagged one", () => {
    expect(
      formatComposerSendError("[PERSONAL_BOT_OWNER_ONLY] nope", false, ["george"]),
    ).toBe(
      "Couldn't send — only @george's owner can add it to this channel. Ask them to add it, then you can tag it here.",
    );
    expect(formatComposerSendError("[PERSONAL_BOT_OWNER_ONLY] nope", false)).toBe(
      "Couldn't send — only that bot's owner can add it to this channel.",
    );
  });
});
