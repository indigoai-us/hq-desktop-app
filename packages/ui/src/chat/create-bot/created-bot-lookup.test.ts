/**
 * Finding the bot a cancelled create may have made, by reading the company's
 * bots (review A-C5). Nothing here sends a create.
 */
import { describe, expect, it } from "vitest";

import {
  createdByAnotherPerson,
  createdByViewer,
  findCreatedBot,
  rosterBaseline,
  rosterBots,
} from "./created-bot-lookup.js";

/** A row as `GET /v1/agents/mobile-roster` returns it. */
function row(agentUid: string, slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentUid,
    uid: agentUid,
    companyUid: "cmp_indigo",
    name: slug,
    displayName: slug,
    slug,
    status: "provisioning",
    setupPhase: "provisioning",
    ...extra,
  };
}

function roster(...rows: Array<Record<string, unknown>>): unknown {
  return { ok: true, value: { agents: rows } };
}

describe("rosterBots", () => {
  it("reads the adapter's answer and the bare payload alike", () => {
    const expected = [{ agentUid: "agt_woah", handle: "woah", companyUid: "cmp_indigo", phase: "provisioning" }];
    expect(rosterBots(roster(row("agt_woah", "Woah")))).toEqual(expected);
    expect(rosterBots({ agents: [row("agt_woah", "woah")] })).toEqual(expected);
    expect(rosterBots([row("agt_woah", "woah")])).toEqual(expected);
    expect(rosterBots(roster())).toEqual([]);
  });

  it("never reads a failed or malformed answer as an empty company", () => {
    expect(rosterBots({ ok: false, reason: "network", code: "timeout", message: "timed out" })).toBeNull();
    expect(rosterBots(null)).toBeNull();
    expect(rosterBots(undefined)).toBeNull();
    expect(rosterBots({ ok: true, value: null })).toBeNull();
    expect(rosterBots({ ok: true, value: { error: "Forbidden" } })).toBeNull();
    expect(rosterBaseline({ ok: false })).toBeNull();
    expect(rosterBaseline(roster(row("agt_old", "scout")))).toEqual(new Set(["agt_old"]));
  });
});

describe("findCreatedBot", () => {
  const before = new Set(["agt_old"]);

  it("finds the bot with the draft's handle that was not there before the create was sent", () => {
    expect(
      findCreatedBot({
        roster: roster(row("agt_old", "scout", { setupPhase: "ready" }), row("agt_woah", "woah")),
        companyUid: "cmp_indigo",
        handle: "Woah ",
        baseline: before,
      }),
    ).toEqual({ kind: "found", agentUid: "agt_woah" });
  });

  it("says absent when no bot has the handle, and unreadable when the read failed", () => {
    expect(
      findCreatedBot({ roster: roster(row("agt_old", "scout")), companyUid: "cmp_indigo", handle: "woah", baseline: before }),
    ).toEqual({ kind: "absent" });
    expect(
      findCreatedBot({ roster: { ok: false, message: "offline" }, companyUid: "cmp_indigo", handle: "woah", baseline: before }),
    ).toEqual({ kind: "unreadable" });
    expect(findCreatedBot({ roster: roster(row("agt_woah", "woah")), companyUid: "cmp_indigo", handle: " ", baseline: before })).toEqual({
      kind: "absent",
    });
  });

  it("never takes a bot that was already there as the one this create made", () => {
    // Somebody's older bot holds the handle: this create was refused, and
    // that bot must not be removed for it.
    expect(
      findCreatedBot({
        roster: roster(row("agt_theirs", "woah", { setupPhase: "ready" })),
        companyUid: "cmp_indigo",
        handle: "woah",
        baseline: new Set(["agt_theirs"]),
      }),
    ).toEqual({ kind: "unproven" });
  });

  it("never takes a bot as this create's own without a list from before the create", () => {
    expect(
      findCreatedBot({ roster: roster(row("agt_woah", "woah")), companyUid: "cmp_indigo", handle: "woah", baseline: null }),
    ).toEqual({ kind: "unproven" });
  });

  it("looks only at this company's bots, and not at one that is being removed", () => {
    expect(
      findCreatedBot({
        roster: roster(row("agt_other", "woah", { companyUid: "cmp_other" })),
        companyUid: "cmp_indigo",
        handle: "woah",
        baseline: before,
      }),
    ).toEqual({ kind: "absent" });
    for (const setupPhase of ["deprovisioning", "deprovisioned"]) {
      expect(
        findCreatedBot({
          roster: roster(row("agt_gone", "woah", { setupPhase })),
          companyUid: "cmp_indigo",
          handle: "woah",
          baseline: before,
        }),
      ).toEqual({ kind: "absent" });
    }
  });
});

describe("createdByAnotherPerson", () => {
  const status = (ownerUid: unknown): unknown => ({ ok: true, value: { agent: { uid: "agt_woah", ownerUid } } });

  it("is true only for a clear mismatch between two person ids", () => {
    expect(createdByAnotherPerson(status("prs_grace"), "prs_ada")).toBe(true);
    expect(createdByAnotherPerson(status("prs_ada"), "prs_ada")).toBe(false);
  });

  it("decides nothing when the answer or the viewer does not say", () => {
    expect(createdByAnotherPerson(status(undefined), "prs_ada")).toBe(false);
    expect(createdByAnotherPerson(status("cmp_indigo"), "prs_ada")).toBe(false);
    expect(createdByAnotherPerson(status("prs_grace"), null)).toBe(false);
    expect(createdByAnotherPerson(status("prs_grace"), "0b1c-cognito-sub")).toBe(false);
    expect(createdByAnotherPerson({ ok: false, status: 403 }, "prs_ada")).toBe(false);
    expect(createdByAnotherPerson(null, "prs_ada")).toBe(false);
  });
});

describe("createdByViewer (round 4, item 4)", () => {
  const status = (ownerUid: unknown): unknown => ({ ok: true, value: { agent: { uid: "agt_woah", ownerUid } } });

  it("is true only when the server names this person as the creator", () => {
    expect(createdByViewer(status("prs_ada"), "prs_ada")).toBe(true);
    expect(createdByViewer(status(" prs_ada "), "prs_ada")).toBe(true);
    expect(createdByViewer(status("prs_grace"), "prs_ada")).toBe(false);
  });

  it("is false when the read failed, or the answer or the viewer does not say", () => {
    expect(createdByViewer(status(undefined), "prs_ada")).toBe(false);
    expect(createdByViewer(status(""), "")).toBe(false);
    expect(createdByViewer(status("prs_ada"), null)).toBe(false);
    expect(createdByViewer(status("prs_ada"), undefined)).toBe(false);
    expect(createdByViewer({ ok: true, value: { setupState: { phase: "provisioning" } } }, "prs_ada")).toBe(false);
    expect(createdByViewer({ ok: false, status: 403 }, "prs_ada")).toBe(false);
    expect(createdByViewer({ ok: false, status: 500 }, "prs_ada")).toBe(false);
    expect(createdByViewer(null, "prs_ada")).toBe(false);
  });
});
