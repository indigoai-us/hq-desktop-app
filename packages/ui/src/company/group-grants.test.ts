import { describe, expect, it, vi } from "vitest";

import {
  GRANT_ROLE_OPTIONS,
  companyName,
  grantErrorCopy,
  grantFormProblem,
  grantOutcomeSummary,
  grantRoleLabel,
  groupGrantsFromBody,
  readGroupGrants,
  splitByStatus,
  submitGrants,
} from "./group-grants.js";

const groups = [
  { id: "grp_ae", name: "AE agent", description: "", members: [], paths: [] },
  { id: "grp_dev", name: "Dev Test", description: "", members: [], paths: [] },
];
const targets = [
  { uid: "cmp_here", label: "Indigo", eligible: true },
  { uid: "cmp_kept", label: "Keptwork", eligible: true },
  { uid: "cmp_vyg", label: "VYG", eligible: false },
];
const ok = (value: unknown) => ({ ok: true as const, value: value as never });
const fail = (code: string) => ({ ok: false as const, reason: "error" as const, code, message: `${code} {"error":"raw"}` });

describe("group grants mapping", () => {
  it("maps hq-pro rows and drops rows without ids", () => {
    const out = groupGrantsFromBody({
      grants: [
        { groupId: "grp_ae", sourceCompanyUid: "cmp_here", targetCompanyUid: "cmp_kept", role: "admin", status: "revoked", targetCompanyName: "Keptwork" },
        { groupId: "grp_dev", sourceCompanyUid: "cmp_here", targetCompanyUid: "cmp_x", role: "guest", status: "active", grantedAt: "2026-10-01T00:00:00Z", targetCompanySlug: "x-co" },
        { groupId: "", sourceCompanyUid: "cmp_here", targetCompanyUid: "cmp_x" },
        null,
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "admin", status: "revoked", targetCompanyName: "Keptwork" });
    expect(out[1]).toMatchObject({ status: "active", targetCompanyName: "x-co", grantedAt: "2026-10-01T00:00:00Z" });
    expect(() => groupGrantsFromBody({ nope: 1 })).toThrow();
  });

  it("splits active from revoked", () => {
    const rows = groupGrantsFromBody({
      grants: [
        { groupId: "a", sourceCompanyUid: "s", targetCompanyUid: "t", status: "active" },
        { groupId: "b", sourceCompanyUid: "s", targetCompanyUid: "t", status: "pending" },
        { groupId: "c", sourceCompanyUid: "s", targetCompanyUid: "t", status: "revoked" },
      ],
    });
    const { active, revoked } = splitByStatus(rows);
    expect(active.map((g) => g.groupId)).toEqual(["a", "b"]);
    expect(revoked.map((g) => g.groupId)).toEqual(["c"]);
  });

  it("never shows a raw company id", () => {
    expect(companyName("Keptwork", "cmp_kept")).toBe("Keptwork");
    expect(companyName("cmp_01ABC", "cmp_01ABC")).toBe("Unknown company");
    expect(companyName(null, "cmp_kept", targets)).toBe("Keptwork");
    expect(companyName("", "cmp_gone", targets)).toBe("Unknown company");
  });

  it("offers Read and Write only, never admin", () => {
    expect(GRANT_ROLE_OPTIONS.map((o) => o.value)).toEqual(["member", "guest"]);
    expect(GRANT_ROLE_OPTIONS.map((o) => o.label)).toEqual(["Write", "Read"]);
    expect(GRANT_ROLE_OPTIONS.some((o) => (o.value as string) === "admin")).toBe(false);
    expect(grantRoleLabel("member")).toBe("Write");
    expect(grantRoleLabel("guest")).toBe("Read");
    expect(grantRoleLabel("admin")).toBe("Admin");
  });
});

describe("grant form validation", () => {
  const ctx = { currentUid: "cmp_here", groups, targets };
  it("accepts a group, an eligible other company and a non-admin role", () => {
    expect(grantFormProblem({ groupId: "grp_ae", targetUids: ["cmp_kept"], role: "member" }, ctx)).toBeNull();
  });
  it("rejects missing picks, the current company, ineligible companies and admin", () => {
    expect(grantFormProblem({ groupId: "", targetUids: ["cmp_kept"], role: "member" }, ctx)).toBe("Pick a group.");
    expect(grantFormProblem({ groupId: "grp_ae", targetUids: [], role: "member" }, ctx)).toBe("Pick at least one company.");
    expect(grantFormProblem({ groupId: "grp_ae", targetUids: ["cmp_here"], role: "member" }, ctx)).toBe("Pick at least one company.");
    expect(grantFormProblem({ groupId: "grp_ae", targetUids: ["cmp_vyg"], role: "member" }, ctx)).toBe("Pick at least one company.");
    expect(grantFormProblem({ groupId: "grp_ae", targetUids: ["cmp_kept"], role: "admin" }, ctx)).toBe("Pick Read or Write.");
  });
  it("explains why granting is unavailable", () => {
    expect(grantFormProblem({ groupId: "", targetUids: [], role: "member" }, { ...ctx, groups: [] })).toContain("no groups");
    expect(grantFormProblem({ groupId: "grp_ae", targetUids: [], role: "member" }, { ...ctx, targets: [] })).toContain("no other companies");
    expect(
      grantFormProblem({ groupId: "grp_ae", targetUids: [], role: "member" }, { ...ctx, targets: [{ uid: "cmp_vyg", label: "VYG", eligible: false }] }),
    ).toContain("owners and admins");
  });
});

describe("grant error copy", () => {
  it("never echoes server text", () => {
    for (const action of ["grant", "revoke", "read"] as const) {
      for (const code of ["http-403", "http-404", "http-429", "http-500", "network"]) {
        const copy = grantErrorCopy(fail(code), action);
        expect(copy).not.toContain("raw");
        expect(copy).not.toContain("http");
      }
    }
    expect(grantErrorCopy(fail("http-403"), "grant")).toContain("owner or admin");
  });
});

describe("grants read and mutations (mocked API)", () => {
  it("reads outbound per group and inbound once", async () => {
    const api = {
      listOutboundGroupGrants: vi.fn(async (_s: string, groupId: string) =>
        ok({ grants: [{ groupId, sourceCompanyUid: "cmp_here", targetCompanyUid: "cmp_kept", role: "member", status: "active" }] }),
      ),
      listInboundGroupGrants: vi.fn(async () => ok({ grants: [] })),
    };
    const read = await readGroupGrants({ api, companyUid: "cmp_here", groups });
    expect(api.listOutboundGroupGrants.mock.calls).toEqual([
      ["cmp_here", "grp_ae"],
      ["cmp_here", "grp_dev"],
    ]);
    expect(api.listInboundGroupGrants).toHaveBeenCalledWith("cmp_here");
    expect(read).toMatchObject({ outboundState: "ready", outboundMissing: 0, inboundState: "ready" });
    expect(read.outbound).toHaveLength(2);
  });

  it("reports a partial outbound read as missing, not zero, and inbound 403 as forbidden", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = {
      listOutboundGroupGrants: vi.fn(async (_s: string, groupId: string) => (groupId === "grp_dev" ? fail("http-500") : ok({ grants: [] }))),
      listInboundGroupGrants: vi.fn(async () => fail("http-403")),
    };
    const read = await readGroupGrants({ api, companyUid: "cmp_here", groups });
    expect(read).toMatchObject({ outboundState: "ready", outboundMissing: 1, inboundState: "forbidden" });
    warn.mockRestore();
  });

  it("fails the outbound list when every group read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = {
      listOutboundGroupGrants: vi.fn(async () => fail("http-500")),
      listInboundGroupGrants: vi.fn(async () => ok({ grants: [] })),
    };
    const read = await readGroupGrants({ api, companyUid: "cmp_here", groups });
    expect(read.outboundState).toBe("failed");
    warn.mockRestore();
  });

  it("fans a grant out per company and keeps going past a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = {
      createGroupGrant: vi.fn(async (input: { targetCompanyUid: string }) => (input.targetCompanyUid === "cmp_vyg" ? fail("http-403") : ok({ grant: {} }))),
    };
    const outcomes = await submitGrants({ api, sourceCompanyUid: "cmp_here", groupId: "grp_ae", targetUids: ["cmp_kept", "cmp_vyg"], role: "guest" });
    expect(api.createGroupGrant).toHaveBeenCalledWith({ groupId: "grp_ae", sourceCompanyUid: "cmp_here", targetCompanyUid: "cmp_kept", role: "guest" });
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    const summary = grantOutcomeSummary(outcomes, targets)!;
    expect(summary).toContain("Granted to 1 of 2 companies.");
    expect(summary).toContain("VYG:");
    expect(summary).not.toContain("raw");
    expect(grantOutcomeSummary([{ uid: "cmp_kept", ok: true, error: null }], targets)).toBeNull();
    warn.mockRestore();
  });
});
