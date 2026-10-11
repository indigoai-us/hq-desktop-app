/**
 * hq-accomplishment-badges US-005: the desktop reads a person's badges from
 * hq-pro `GET /v1/badges/{uid}`. The body is untrusted at this boundary, so
 * the parser keeps only well-formed rows, and every adapter returns the same
 * parsed shape (or a failure the UI turns into "no badges").
 */
import { describe, expect, it } from "vitest";

import { NO_BADGES, parseBadgesPayload } from "./badges.js";
import { TauriPlatformAdapter } from "./tauri/index.js";
import { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";
import { WEB_PATHS, WebPlatformAdapter } from "./web/index.js";

const ENABLED = {
  enabled: true,
  subject: { uid: "prs_ada", kind: "person" },
  consent: "granted",
  badges: [
    { id: "founding", tier: 3, earnedAt: "2026-03-02T10:00:00.000Z" },
    { id: "bughunter", tier: 2, earnedAt: "2026-09-28T10:00:00.000Z" },
  ],
  progress: [{ id: "maker", current: 2, target: 5, unit: "skills" }],
};

describe("parseBadgesPayload", () => {
  it("keeps a well-formed enabled response as it is", () => {
    expect(parseBadgesPayload(ENABLED)).toEqual(ENABLED);
  });

  it("is empty while the server's flag is off, whatever else the body says", () => {
    expect(
      parseBadgesPayload({ enabled: false, subject: null, consent: null, badges: ENABLED.badges, progress: ENABLED.progress }),
    ).toEqual(NO_BADGES);
  });

  it("is empty for a body that is not an object", () => {
    for (const raw of [null, undefined, "nope", 42, [], [ENABLED]]) {
      expect(parseBadgesPayload(raw)).toEqual(NO_BADGES);
    }
  });

  it("coerces non-array badges and progress to empty lists", () => {
    const parsed = parseBadgesPayload({ ...ENABLED, badges: { id: "founding" }, progress: "maker" });
    expect(parsed.badges).toEqual([]);
    expect(parsed.progress).toEqual([]);
    expect(parsed.enabled).toBe(true);
  });

  it("drops rows with an unknown tier, a bad id or a bad date, and repeats", () => {
    const parsed = parseBadgesPayload({
      ...ENABLED,
      badges: [
        { id: "maker", tier: 4, earnedAt: "2026-10-01" },
        { id: "maker", tier: "2", earnedAt: "2026-10-01" },
        { id: "Bad Id", tier: 1, earnedAt: "2026-10-01" },
        { id: "fleet", tier: 1, earnedAt: "not a date" },
        { id: "fleet", tier: 1 },
        null,
        "founder",
        { id: "founder", tier: 3, earnedAt: "2026-03-04" },
        { id: "founder", tier: 1, earnedAt: "2026-03-05" },
      ],
    });
    expect(parsed.badges).toEqual([{ id: "founder", tier: 3, earnedAt: "2026-03-04" }]);
  });

  it("drops progress without a positive target or a count, and defaults the unit", () => {
    const parsed = parseBadgesPayload({
      ...ENABLED,
      progress: [
        { id: "maker", current: 2, target: 0, unit: "skills" },
        { id: "fleet", current: -1, target: 1, unit: "agents" },
        { id: "bughunter", current: Number.NaN, target: 3, unit: "reports" },
        { id: "poweruser", current: 64, target: 100 },
      ],
    });
    expect(parsed.progress).toEqual([{ id: "poweruser", current: 64, target: 100, unit: "" }]);
  });

  it("keeps the subject only for a person, and the consent only when known", () => {
    expect(parseBadgesPayload({ ...ENABLED, subject: { uid: "agt_x", kind: "agent" }, consent: "yes" })).toMatchObject({
      subject: null,
      consent: null,
    });
  });
});

describe("WEB_PATHS.badges", () => {
  it("encodes the uid into the route", () => {
    expect(WEB_PATHS.badges("me")).toBe("/v1/badges/me");
    expect(WEB_PATHS.badges("prs_a/b")).toBe("/v1/badges/prs_a%2Fb");
  });
});

function syncAdapter(status: number, body: unknown) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { status, body: JSON.stringify(body) };
    },
    fetch: (() => {
      throw new Error("the adapter must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
    requestPolicy: { sleep: async () => {}, random: () => 0 },
  });
  return { adapter, calls };
}

describe("sync adapter getBadges", () => {
  it("GETs the badges route through hq_pro_fetch and parses the body", async () => {
    const { adapter, calls } = syncAdapter(200, { ...ENABLED, badges: [...ENABLED.badges, { id: "x", tier: 9 }] });
    const res = await adapter.identity.getBadges!("prs_ada");
    expect(calls).toEqual([{ cmd: "hq_pro_fetch", args: { url: "/v1/badges/prs_ada", method: "GET", body: null } }]);
    expect(res).toEqual({ ok: true, value: ENABLED });
  });

  it("returns the failure for a 404, so the caller shows no badges", async () => {
    const { adapter } = syncAdapter(404, { code: "BADGES_SUBJECT_NOT_FOUND" });
    const res = await adapter.identity.getBadges!("prs_stranger");
    expect(res.ok).toBe(false);
  });
});

describe("tauri adapter getBadges", () => {
  it("uses the same route and parser", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 200, body: JSON.stringify({ enabled: false, subject: null, consent: null, badges: [], progress: [] }) };
      },
    });
    const res = await adapter.identity.getBadges!("me");
    expect(calls[0]).toEqual({ cmd: "hq_pro_fetch", args: { url: "/v1/badges/me", method: "GET", body: null } });
    expect(res).toEqual({ ok: true, value: NO_BADGES });
  });
});

describe("web adapter getBadges", () => {
  it("GETs the badges route and parses the body", async () => {
    const paths: string[] = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        paths.push(`${init?.method ?? "GET"} ${String(input).replace("https://api.test", "")}`);
        return new Response(JSON.stringify(ENABLED), { status: 200 });
      },
    });
    const res = await adapter.identity.getBadges!("prs_ada");
    expect(paths).toEqual(["GET /v1/badges/prs_ada"]);
    expect(res).toEqual({ ok: true, value: ENABLED });
  });

  it("returns a failure for a 404", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () => new Response(JSON.stringify({ code: "BADGES_SUBJECT_NOT_FOUND" }), { status: 404 }),
    });
    expect((await adapter.identity.getBadges!("prs_x")).ok).toBe(false);
  });
});
