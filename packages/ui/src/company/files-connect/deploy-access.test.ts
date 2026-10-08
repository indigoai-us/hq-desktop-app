import { ok } from "@hq/platform";
import { describe, expect, it, vi } from "vitest";
import {
  applyAccess,
  deployAccessClient,
  draftFrom,
  isDirty,
  loadAccess,
  planAccess,
  type AccessState,
} from "./deploy-access.js";

function fakeRequest(value: Record<string, unknown> = {}) {
  return vi.fn(async (..._args: unknown[]) => ok(value));
}

describe("QA-059 deploy access client request shapes", () => {
  it("reads and writes the access policy", async () => {
    const req = fakeRequest({ mode: "company" });
    const c = deployAccessClient(req, "indigo");
    await c.getPolicy("app_1");
    await c.putPolicy("app_1", { mode: "selected", companyUid: "cmp_1", users: [{ id: "prs_a" }], groups: [] });
    expect(req.mock.calls[0]).toEqual(["indigo", "GET", "/api/apps/app_1/access-policy", undefined]);
    expect(req.mock.calls[1]).toEqual([
      "indigo",
      "PUT",
      "/api/apps/app_1/access-policy",
      { mode: "selected", companyUid: "cmp_1", users: [{ id: "prs_a" }], groups: [] },
    ]);
  });

  it("switches mode and edits the allowlist", async () => {
    const req = fakeRequest();
    const c = deployAccessClient(req, "indigo");
    await c.setMode("app_1", { mode: "password", password: "hunter2hunter2" });
    await c.listEmails("app_1");
    await c.addEmail("app_1", "@example.com");
    await c.removeEmail("app_1", "a+b@example.com");
    expect(req.mock.calls).toEqual([
      ["indigo", "POST", "/api/apps/app_1/access-mode", { mode: "password", password: "hunter2hunter2" }],
      ["indigo", "GET", "/api/apps/app_1/allowed-emails", undefined],
      ["indigo", "POST", "/api/apps/app_1/allowed-emails", { email: "@example.com" }],
      ["indigo", "DELETE", "/api/apps/app_1/allowed-emails/a%2Bb%40example.com", undefined],
    ]);
  });

  it("throws the host message on failure", async () => {
    const req = vi.fn(async () => ({ ok: false as const, reason: "network", message: "deploy access HTTP 403: Forbidden" }));
    const c = deployAccessClient(req as never, "indigo");
    await expect(c.getPolicy("app_1")).rejects.toThrow("HTTP 403");
  });
});

describe("QA-059 loading and planning", () => {
  const company: AccessState = { mode: "company", companyUid: "cmp_1", users: [], groups: [], emails: [] };
  const allowlist: AccessState = {
    mode: "private",
    companyUid: "cmp_1",
    users: [],
    groups: [],
    emails: [{ pattern: "a@x.co", patternKey: "a@x.co" }, { pattern: "@y.co", patternKey: "@y.co" }],
  };

  it("loads the allowlist when the app row is private", async () => {
    const req = vi.fn(async (_s: string, _m: string, path: string) =>
      ok(path.endsWith("allowed-emails") ? { emails: [{ pattern: "a@x.co", patternKey: "a@x.co" }] } : {}),
    );
    const state = await loadAccess(deployAccessClient(req as never, "indigo"), "app_1", { privateMode: true }, "cmp_1");
    expect(state.mode).toBe("private");
    expect(state.emails.map((e) => e.pattern)).toEqual(["a@x.co"]);
    expect(req).toHaveBeenCalledTimes(1);
  });

  it("loads selected users from the policy", async () => {
    const req = fakeRequest({ mode: "selected", companyUid: "cmp_1", users: [{ id: "prs_a" }], groups: [{ id: "grp_1" }] });
    const state = await loadAccess(deployAccessClient(req, "indigo"), "app_1");
    expect(state).toMatchObject({ mode: "selected", users: ["prs_a"], groups: ["grp_1"] });
  });

  it("is clean until something changes", () => {
    const d = draftFrom(company);
    expect(isDirty(company, d)).toBe(false);
    expect(planAccess(company, d, "app_1").steps).toEqual([]);
  });

  it("company to public is one access-mode call", () => {
    const plan = planAccess(company, { ...draftFrom(company), mode: "public" }, "app_1");
    expect(plan.steps).toEqual([{ method: "POST", path: "/api/apps/app_1/access-mode", body: { mode: "public" } }]);
    expect(plan.summary[0]).toContain("from Company members to Public");
  });

  it("password needs 8 characters and uses the policy route with a company", () => {
    const short = planAccess(company, { ...draftFrom(company), mode: "password", password: "short" }, "app_1");
    expect(short.blocked).toMatch(/at least 8/);
    const plan = planAccess(company, { ...draftFrom(company), mode: "password", password: "longenough" }, "app_1");
    expect(plan.steps).toEqual([
      { method: "PUT", path: "/api/apps/app_1/access-policy", body: { mode: "password", companyUid: "cmp_1", password: "longenough" } },
    ]);
    expect(plan.summary.join(" ")).not.toContain("longenough");
  });

  it("leaving the allowlist writes the new gate before removing entries", () => {
    const plan = planAccess(allowlist, { ...draftFrom(allowlist), mode: "company" }, "app_1");
    expect(plan.steps.map((s) => `${s.method} ${s.path}`)).toEqual([
      "PUT /api/apps/app_1/access-policy",
      "DELETE /api/apps/app_1/allowed-emails/a%40x.co",
      "DELETE /api/apps/app_1/allowed-emails/%40y.co",
    ]);
  });

  it("allowlist edits add and remove only the difference", () => {
    const plan = planAccess(allowlist, { ...draftFrom(allowlist), emails: ["a@x.co", "b@z.co"] }, "app_1");
    expect(plan.steps).toEqual([
      { method: "POST", path: "/api/apps/app_1/allowed-emails", body: { email: "b@z.co" } },
      { method: "DELETE", path: "/api/apps/app_1/allowed-emails/%40y.co" },
    ]);
    expect(plan.summary).toEqual(["Add b@z.co.", "Remove @y.co."]);
  });

  it("selected mode needs someone and sends ids", () => {
    const empty = planAccess(company, { ...draftFrom(company), mode: "selected" }, "app_1");
    expect(empty.blocked).toMatch(/at least one/);
    const plan = planAccess(company, { ...draftFrom(company), mode: "selected", users: ["prs_a"] }, "app_1", () => "Ada");
    expect(plan.steps).toEqual([
      { method: "PUT", path: "/api/apps/app_1/access-policy", body: { mode: "selected", companyUid: "cmp_1", users: [{ id: "prs_a" }], groups: [] } },
    ]);
    expect(plan.summary).toContain("Add Ada.");
  });

  it("applyAccess runs steps in order", async () => {
    const req = fakeRequest();
    const plan = planAccess(allowlist, { ...draftFrom(allowlist), mode: "public" }, "app_1");
    await applyAccess(deployAccessClient(req, "indigo"), plan);
    expect(req.mock.calls[0]).toEqual(["indigo", "POST", "/api/apps/app_1/access-mode", { mode: "public" }]);
  });
});
