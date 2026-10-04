import { describe, expect, it } from "vitest";

import { appConnectFinish, type AppConnectFinishInput } from "./app-connect-finish.js";
import { CONNECTING_TIMEOUT_MS, recordGrant } from "../chat/messaging/connection-card-model.js";
import type { CompanyConnection } from "../chat/messaging/integration-cards-model.js";

/**
 * C-2: a "connecting" record left in localStorage must never give a bot a
 * private connection with no press. Only a connection that answers a press
 * made just now is shared without a second press.
 */

const NOW = Date.parse("2026-10-04T08:00:00.000Z");
const PRESSED = NOW - 60_000;

function connection(over: Partial<CompanyConnection> = {}): CompanyConnection {
  return {
    id: "acct_linear",
    provider: "linear",
    name: "Linear",
    domain: "linear.app",
    createdBy: "prs_me",
    createdAt: new Date(PRESSED + 30_000).toISOString(),
    mode: "private",
    ...over,
  };
}

function input(over: Partial<AppConnectFinishInput> = {}): AppConnectFinishInput {
  return {
    entry: { state: "connecting", since: PRESSED },
    connection: connection(),
    domain: "linear.app",
    company: { viewerUid: "prs_me" },
    record: null,
    now: NOW,
    ...over,
  };
}

describe("appConnectFinish", () => {
  it("shares a connection made after a recent press, by this person, for exactly the card's domain", () => {
    expect(appConnectFinish(input())).toBe("grant");
  });

  it("only tells the bot when the connection is already open to everyone or already shared from here", () => {
    expect(appConnectFinish(input({ connection: connection({ mode: "everyone" }) }))).toBe("announce");
    expect(appConnectFinish(input({ record: recordGrant(null, "acct_linear", "Linear", NOW) }))).toBe("announce");
  });

  it("forgets a stale press: the record sat in storage longer than the wait", () => {
    const since = NOW - CONNECTING_TIMEOUT_MS - 1;
    // Even a connection made after that press is not shared.
    const made = connection({ createdAt: new Date(since + 30_000).toISOString() });
    expect(appConnectFinish(input({ entry: { state: "connecting", since }, connection: made }))).toBe("forget");
    // A record from days ago, and a connection made yesterday.
    const old = NOW - 3 * 86_400_000;
    expect(
      appConnectFinish(
        input({ entry: { state: "connecting", since: old }, connection: connection({ createdAt: new Date(NOW - 86_400_000).toISOString() }) }),
      ),
    ).toBe("forget");
  });

  it("forgets when the connection was already there at the press, or its date cannot be read", () => {
    expect(appConnectFinish(input({ connection: connection({ createdAt: new Date(PRESSED).toISOString() }) }))).toBe("forget");
    expect(appConnectFinish(input({ connection: connection({ createdAt: new Date(PRESSED - 86_400_000).toISOString() }) }))).toBe("forget");
    expect(appConnectFinish(input({ connection: connection({ createdAt: "" }) }))).toBe("forget");
    expect(appConnectFinish(input({ connection: connection({ createdAt: "not a date" }) }))).toBe("forget");
  });

  it("forgets when the domain is not exactly the card's", () => {
    expect(appConnectFinish(input({ connection: connection({ domain: "api.linear.app" }) }))).toBe("forget");
    expect(appConnectFinish(input({ domain: "api.linear.app" }))).toBe("forget");
    expect(appConnectFinish(input({ domain: "linear.com" }))).toBe("forget");
    expect(appConnectFinish(input({ connection: connection({ domain: null }) }))).toBe("forget");
  });

  it("never shares on a record without a valid press time", () => {
    for (const since of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "1759564800000"]) {
      const entry = { state: "connecting", since } as unknown as AppConnectFinishInput["entry"];
      // The connection is as new as can be: it still does not count.
      expect(appConnectFinish(input({ entry, connection: connection({ createdAt: new Date(NOW - 1).toISOString() }) })), String(since)).toBe("forget");
    }
    // A press time in the future is not a press that happened.
    expect(
      appConnectFinish(
        input({ entry: { state: "connecting", since: NOW + 60_000 }, connection: connection({ createdAt: new Date(NOW + 120_000).toISOString() }) }),
      ),
    ).toBe("forget");
  });

  it("forgets a connection someone else made, and a list that does not say who is looking", () => {
    expect(appConnectFinish(input({ connection: connection({ createdBy: "prs_teammate" }) }))).toBe("forget");
    expect(appConnectFinish(input({ company: { viewerUid: "" }, connection: connection({ createdBy: "" }) }))).toBe("forget");
    expect(appConnectFinish(input({ company: null }))).toBe("forget");
  });

  it("forgets when there is no press, a declined card, or no connection", () => {
    expect(appConnectFinish(input({ entry: null }))).toBe("forget");
    expect(appConnectFinish(input({ entry: { state: "declined", since: PRESSED } }))).toBe("forget");
    expect(appConnectFinish(input({ connection: null }))).toBe("forget");
  });
});
