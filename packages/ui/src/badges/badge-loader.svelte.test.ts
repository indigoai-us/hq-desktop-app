/**
 * The hq-pro badge loader: one read per person, a cache the views share, a
 * refresh after BADGE_REFRESH_MS, and "no badges" for anything that fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, BadgesPayload } from "@hq/platform";
import {
  BADGE_REFRESH_MS,
  badgeUid,
  earnedFromPayload,
  installBadgeLoader,
  progressFromPayload,
  resetBadgeLoader,
  setBadgeLoaderClock,
  type BadgeApi,
} from "./badge-loader.svelte.js";
import { badgeProgressFor, badgesFor, hasBadgeSource, setBadgeProgressSource, setBadgeSource } from "./badge-source.js";

const ADA = { kind: "person" as const, name: "Ada Lovelace", uid: "prs_ada" };

const PAYLOAD: BadgesPayload = {
  enabled: true,
  subject: { uid: "prs_ada", kind: "person" },
  consent: "granted",
  badges: [
    { id: "bughunter", tier: 2, earnedAt: "2026-09-28T10:00:00.000Z" },
    { id: "founding", tier: "L", earnedAt: "2026-03-02T10:00:00.000Z" },
    { id: "founder", tier: 1, earnedAt: "2026-03-04T10:00:00.000Z" },
    { id: "maker", tier: "L", earnedAt: "2026-10-01T10:00:00.000Z" },
    { id: "signedup", tier: 1, earnedAt: "2026-10-02T10:00:00.000Z" },
  ],
  progress: [
    { id: "fleet", current: 0, target: 1, unit: "agents" },
    { id: "bughunter", current: 12, target: 25, unit: "reports" },
    { id: "nope", current: 1, target: 2, unit: "things" },
  ],
};

function api(answer: () => Promise<AdapterResult<BadgesPayload>>): BadgeApi & { getBadges: ReturnType<typeof vi.fn> } {
  return { getBadges: vi.fn((_uid: string) => answer()) };
}

const okPayload = (value: BadgesPayload = PAYLOAD) => () => Promise.resolve({ ok: true as const, value });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

let uninstall: () => void = () => {};
let clock = 1_000_000;

beforeEach(() => {
  clock = 1_000_000;
  setBadgeLoaderClock(() => clock);
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
  resetBadgeLoader();
  setBadgeLoaderClock(null);
  setBadgeSource(null);
  setBadgeProgressSource(null);
  vi.restoreAllMocks();
});

describe("which subjects are looked up", () => {
  it("uses a person's prs_ uid only: never a name, a bot, or another kind of uid", () => {
    expect(badgeUid(ADA)).toBe("prs_ada");
    expect(badgeUid({ kind: "person", name: "Ada Lovelace" })).toBeNull();
    expect(badgeUid({ kind: "person", name: "Ada", uid: "  " })).toBeNull();
    expect(badgeUid({ kind: "person", name: "Ada", uid: "agt_scout" })).toBeNull();
    expect(badgeUid({ kind: "bot", name: "scout", uid: "prs_ada" })).toBeNull();
  });
});

describe("reading the payload", () => {
  it("keeps known badges, draws single-level ones at their own tier, and drops unknown tiers", () => {
    expect(earnedFromPayload(PAYLOAD)).toEqual([
      { id: "bughunter", tier: 2, earnedAt: "2026-09-28T10:00:00.000Z" },
      { id: "founding", tier: 3, earnedAt: "2026-03-02T10:00:00.000Z" },
      { id: "founder", tier: 3, earnedAt: "2026-03-04T10:00:00.000Z" },
    ]);
  });

  it("keeps progress toward known badges not yet earned", () => {
    expect(progressFromPayload(PAYLOAD, earnedFromPayload(PAYLOAD))).toEqual([
      { id: "fleet", current: 0, target: 1, unit: "agents" },
    ]);
  });

  it("is empty while the server's flag is off", () => {
    const off = { ...PAYLOAD, enabled: false };
    expect(earnedFromPayload(off)).toEqual([]);
    expect(progressFromPayload(off, [])).toEqual([]);
  });
});

describe("the loader", () => {
  it("installs only for an adapter that can read badges, and never over the harness samples", () => {
    uninstall = installBadgeLoader({});
    expect(hasBadgeSource()).toBe(false);
    const samples = () => [{ id: "founder", earnedAt: "2026-03-04" }];
    setBadgeSource(samples);
    const reader = api(okPayload());
    uninstall = installBadgeLoader(reader);
    expect(badgesFor(ADA)).toEqual(samples());
    expect(reader.getBadges).not.toHaveBeenCalled();
  });

  it("reads each person once, shares the answer, and fills progress from the same read", async () => {
    const reader = api(okPayload());
    uninstall = installBadgeLoader(reader);
    expect(badgesFor(ADA)).toEqual([]);
    expect(badgesFor(ADA)).toEqual([]);
    expect(badgeProgressFor(ADA)).toEqual([]);
    await flush();
    expect(reader.getBadges).toHaveBeenCalledTimes(1);
    expect(reader.getBadges).toHaveBeenCalledWith("prs_ada");
    expect(badgesFor(ADA).map((b) => b.id)).toEqual(["bughunter", "founding", "founder"]);
    expect(badgeProgressFor(ADA).map((p) => p.id)).toEqual(["fleet"]);
    badgesFor(ADA);
    badgeProgressFor({ ...ADA, name: "Someone else's label" });
    await flush();
    expect(reader.getBadges).toHaveBeenCalledTimes(1);
  });

  it("never reads for a subject without a person uid", async () => {
    const reader = api(okPayload());
    uninstall = installBadgeLoader(reader);
    expect(badgesFor({ kind: "person", name: "Ada Lovelace" })).toEqual([]);
    expect(badgesFor({ kind: "bot", name: "scout", uid: "agt_scout" })).toEqual([]);
    await flush();
    expect(reader.getBadges).not.toHaveBeenCalled();
  });

  it("reads again after the refresh window, keeping the old answer meanwhile", async () => {
    const reader = api(okPayload());
    uninstall = installBadgeLoader(reader);
    badgesFor(ADA);
    await flush();
    clock += BADGE_REFRESH_MS - 1;
    expect(badgesFor(ADA)).toHaveLength(3);
    await flush();
    expect(reader.getBadges).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(badgesFor(ADA)).toHaveLength(3);
    await flush();
    expect(reader.getBadges).toHaveBeenCalledTimes(2);
  });

  it("shows no badges when the read fails, and does not retry until the refresh", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const reader = api(() => Promise.resolve({ ok: false as const, reason: "error" as const, code: "http-404", message: "Not found" }));
    uninstall = installBadgeLoader(reader);
    badgesFor(ADA);
    await flush();
    expect(badgesFor(ADA)).toEqual([]);
    expect(badgeProgressFor(ADA)).toEqual([]);
    await flush();
    expect(reader.getBadges).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalled();
  });

  it("shows no badges when the read rejects or throws", async () => {
    const rejecting = api(() => Promise.reject(new Error("offline")));
    uninstall = installBadgeLoader(rejecting);
    badgesFor(ADA);
    await flush();
    expect(badgesFor(ADA)).toEqual([]);
    uninstall();

    const throwing: BadgeApi = {
      getBadges: () => {
        throw new Error("boom");
      },
    };
    uninstall = installBadgeLoader(throwing);
    expect(() => badgesFor(ADA)).not.toThrow();
    await flush();
    expect(badgesFor(ADA)).toEqual([]);
  });

  it("drops the cache on uninstall, and ignores an answer that lands after it", async () => {
    let resolve: (value: AdapterResult<BadgesPayload>) => void = () => {};
    const reader = api(() => new Promise((r) => (resolve = r)));
    uninstall = installBadgeLoader(reader);
    badgesFor(ADA);
    await flush();
    uninstall();
    expect(hasBadgeSource()).toBe(false);
    resolve({ ok: true, value: PAYLOAD });
    await flush();
    const next = api(() => Promise.resolve({ ok: true as const, value: { ...PAYLOAD, badges: [] } }));
    uninstall = installBadgeLoader(next);
    badgesFor(ADA);
    await flush();
    expect(badgesFor(ADA)).toEqual([]);
    expect(next.getBadges).toHaveBeenCalledTimes(1);
  });
});
