import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import {
  isAlreadyExistsFailure,
  isRawBotFailureText,
  isValidLocalBotName,
  plainBotFailure,
  locallyHostedBots,
  promotedBotCompany,
  lastHeartbeatLabel,
  localBotsAsContacts,
  localBotForRow,
  localBotOfflineNotice,
  localBotPresence,
} from "./local-bots.js";

const bot = (over: Partial<LocalBotRow> = {}): LocalBotRow => ({
  name: "scout",
  agentUid: "agt_01LOCAL",
  ownerUid: "prs_me",
  runtime: "claude",
  state: "running",
  pid: 42,
  processAlive: true,
  online: true,
  lastHeartbeatAt: "2026-09-10T12:00:00.000Z",
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/Users/me/.hq/bots/scout",
  ...over,
});

describe("local bot presence (US-009)", () => {
  it("matches a DM row to the bot behind its agt_ uid", () => {
    expect(localBotForRow([bot()], { kind: "dm", personUid: "agt_01LOCAL" })?.name).toBe("scout");
    expect(localBotForRow([bot()], { kind: "dm", personUid: "agt_OTHER" })).toBeNull();
    expect(localBotForRow([bot()], { kind: "channel", personUid: "agt_01LOCAL" })).toBeNull();
    expect(localBotForRow([bot()], null)).toBeNull();
  });
  it("is online only on the server's say-so", () => {
    expect(localBotPresence([bot()], { kind: "dm", personUid: "agt_01LOCAL" })).toBe("online");
    expect(localBotPresence([bot({ online: false })], { kind: "dm", personUid: "agt_01LOCAL" })).toBe("offline");
    expect(localBotPresence([bot({ online: null, processAlive: true })], { kind: "dm", personUid: "agt_01LOCAL" })).toBe("offline");
    expect(localBotPresence([bot()], { kind: "dm", personUid: "prs_human" })).toBeNull();
  });
  it("explains why a bot is not answering", () => {
    expect(localBotOfflineNotice(bot({ online: false, processAlive: false, state: "stopped" }))).toMatch(/computer is off or the bot is stopped/);
    expect(localBotOfflineNotice(bot({ online: false, processAlive: true }))).toMatch(/starting up/);
    expect(localBotOfflineNotice(bot({ online: false, processAlive: false, state: "failed" }))).toMatch(/repeated errors/);
  });
  it("explains a promotion hold before ordinary offline or failure state", () => {
    expect(localBotOfflineNotice(bot({ online: false, state: "failed", promotionHold: { companyUid: "cmp_target" } }))).toContain("paused for cloud promotion");
  });
  it("formats the last heartbeat relatively", () => {
    const now = Date.parse("2026-09-10T12:01:00.000Z");
    expect(lastHeartbeatLabel("2026-09-10T12:00:45.000Z", now)).toBe("checked in 15s ago");
    expect(lastHeartbeatLabel("2026-09-10T11:30:00.000Z", now)).toBe("checked in 31m ago");
    expect(lastHeartbeatLabel(null, now)).toBeNull();
    expect(lastHeartbeatLabel("garbage", now)).toBeNull();
  });
});

describe("isValidLocalBotName", () => {
  it("accepts slugs and rejects everything the CLI rejects", () => {
    expect(isValidLocalBotName("assistant")).toBe(true);
    expect(isValidLocalBotName("scout-2")).toBe(true);
    expect(isValidLocalBotName("Scout")).toBe(false);
    expect(isValidLocalBotName("-x")).toBe(false);
    expect(isValidLocalBotName("a--b")).toBe(false);
    expect(isValidLocalBotName("")).toBe(false);
    expect(isValidLocalBotName("a".repeat(41))).toBe(false);
  });
});

describe("localBotsAsContacts", () => {
  it("appends the user's bots as DM contacts without duplicating roster rows", () => {
    const roster = [{ personUid: "prs_a", displayName: "A" }, { personUid: "agt_01LOCAL", displayName: "already" }];
    const out = localBotsAsContacts(roster, [bot(), bot({ name: "iris", agentUid: "agt_02" })]);
    expect(out.map((c) => c.personUid)).toEqual(["prs_a", "agt_01LOCAL", "agt_02"]);
    expect(out[2]).toEqual({ personUid: "agt_02", displayName: "iris", companyUid: null });
    expect(localBotsAsContacts(roster, null)).toEqual(roster);
  });
});


it("routes a promoted UID out of local controls while keeping pending and older bots local", () => {
  const promoted = bot({ hosting: "cloud" });
  const pending = bot({ agentUid: "agt_PENDING", promotionHold: { companyUid: "cmp_TEST" } });
  const old = bot({ agentUid: "agt_OLD" });
  const local = locallyHostedBots([promoted, pending, old]);
  expect(local.map(b => b.agentUid)).toEqual(["agt_PENDING", "agt_OLD"]);
  expect(localBotForRow(local, { kind: "dm", personUid: promoted.agentUid })).toBeNull();
});


it("uses the promoted destination for the original personal DM profile", () => {
  const promoted = bot({ hosting: "cloud", promotionHold: { companyUid: "cmp_TARGET" } });
  expect(promotedBotCompany([promoted], promoted.agentUid)).toBe("cmp_TARGET");
  expect(promotedBotCompany([promoted], "agt_OTHER")).toBeNull();
  expect(promotedBotCompany([bot({ promotionHold: { companyUid: "cmp_TARGET" } })], promoted.agentUid)).toBeNull();
});

/**
 * The bots API shells out to `hq bot …`, so a failure's `message` is whatever
 * the CLI printed — often hq-pro's own words. The owner saw exactly this on
 * the #welcome hero: `HQ API /v1/agents → 409: Entity with type="agent" and
 * slug="setup-rg13gzm4" already exists`.
 */
describe("plainBotFailure", () => {
  const API_409 = 'HQ API /v1/agents → 409: Entity with type="agent" and slug="setup-rg13gzm4" already exists';

  it("never lets the API's own words reach a person", () => {
    const shown = plainBotFailure(API_409, "Could not create setup.");
    expect(shown).toBe("Could not create setup.");
    expect(shown).not.toContain("HQ API");
    expect(shown).not.toContain("409");
    expect(shown).not.toContain("slug=");
  });

  it("replaces status lines, error codes, stacks, JSON and machine paths", () => {
    const fallback = "Could not create setup.";
    for (const raw of [
      "Request failed (status 500)",
      "LOCAL_BOT_CAP_REACHED",
      "TypeError: undefined is not a function",
      "    at run (/app/dist/index.js:11:9)",
      '{"error":"nope"}',
      "409 Conflict",
      'Bot "setup" already exists (/Users/sam/.hq/bots/setup). Use hq bot start setup.',
      "See https://hq.example.com/docs for details",
    ]) {
      expect(plainBotFailure(raw, fallback), raw).toBe(fallback);
    }
  });

  it("passes a written sentence through, and keeps only its first line", () => {
    expect(plainBotFailure("Claude Code is not signed in.", "x")).toBe("Claude Code is not signed in.");
    expect(plainBotFailure("Claude Code is not signed in.\nRun the sign-in again.", "x")).toBe(
      "Claude Code is not signed in.",
    );
  });

  it("falls back on nothing at all", () => {
    expect(plainBotFailure("", "x")).toBe("x");
    expect(plainBotFailure(null, "x")).toBe("x");
    expect(plainBotFailure("   ", "x")).toBe("x");
  });

  it("isRawBotFailureText answers for the same shapes", () => {
    expect(isRawBotFailureText(API_409)).toBe(true);
    expect(isRawBotFailureText("Claude Code is not signed in.")).toBe(false);
    expect(isRawBotFailureText("")).toBe(false);
  });
});

describe("isAlreadyExistsFailure", () => {
  it("recognises the 409 the cloud returns when the account already owns the bot", () => {
    expect(
      isAlreadyExistsFailure('HQ API /v1/agents → 409: Entity with type="agent" and slug="setup-rg13gzm4" already exists'),
    ).toBe(true);
  });

  it("recognises the CLI's own local duplicate, the bare 409 and the error code", () => {
    expect(isAlreadyExistsFailure('Bot "setup" already exists (/Users/sam/.hq/bots/setup).')).toBe(true);
    expect(isAlreadyExistsFailure("HQ API /v1/agents → 409")).toBe(true);
    expect(isAlreadyExistsFailure("409 Conflict")).toBe(true);
    expect(isAlreadyExistsFailure("ENTITY_EXISTS")).toBe(true);
  });

  it("is not fooled by other failures", () => {
    expect(isAlreadyExistsFailure("Claude Code is not signed in.")).toBe(false);
    expect(isAlreadyExistsFailure("HQ API /v1/agents → 500: server error")).toBe(false);
    expect(isAlreadyExistsFailure("")).toBe(false);
    expect(isAlreadyExistsFailure(null)).toBe(false);
  });
});
