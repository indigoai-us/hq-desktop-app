import { describe, expect, it, vi } from "vitest";

import {
  createCompanyOutpostClient,
  parseCompanyOutpostDetail,
  parseCompanyOutpostList,
  parseProvision,
  parseProvisionStatus,
} from "./company-outpost-client.js";
import { failureCopy, listAfterProvision, emptyHealth } from "./company-outpost-model.js";
import type { AdapterResult, Json } from "@hq/platform";

function ok(value: Json): AdapterResult<Json> {
  return { ok: true, value };
}

describe("company outpost client", () => {
  it("reads the list fields from the list payload", () => {
    const parsed = parseCompanyOutpostList({
      price: { monthlyUsd: 100, currency: "USD", payer: "company" },
      cap: 5,
      outposts: [
        {
          outpostId: "demo-1",
          name: "main",
          state: "ready",
          lastSeenAt: "2026-10-18T15:00:00.000Z",
          jobsCount: 2,
          jobHealth: { ok: 1, missed: 1, blocked: 0, stale: 0, unknown: 0 },
        },
      ],
    });
    expect(parsed?.items[0]).toMatchObject({ id: "demo-1", name: "main", state: "running", jobsCount: 2 });
    expect(parsed).toEqual({ items: parsed?.items, cap: 5 });
    expect(JSON.stringify(parsed)).not.toMatch(/USD|price|payer|billed/i);
  });

  it("does not treat an error body as an empty company", () => {
    expect(parseCompanyOutpostList({ error: true })).toBeNull();
  });

  it("keeps the created date and drops host secrets on detail", () => {
    const detail = parseCompanyOutpostDetail({
      outpostId: "demo-1",
      name: "main",
      lifecycle: "blocked",
      sessionToken: "sk-secret",
      createdAt: "October 17, 2026",
      host: { instanceId: "i-1", executionPrincipal: "arn:secret", payerCompanyUid: "cmp_1" },
      jobs: [{ jobId: "inbox-check", name: "inbox-check", health: "blocked", lastRunAt: "2026-10-18T13:00:00.000Z" }],
      runs: [{ id: "r1", jobId: "inbox-check", jobName: "inbox-check", at: "2026-10-18T13:00:00.000Z", health: "blocked" }],
    });
    expect(detail?.machine).toEqual({ region: "", instanceId: "", createdAt: "October 17, 2026" });
    expect(JSON.stringify(detail)).not.toContain("sk-secret");
    expect(JSON.stringify(detail)).not.toContain("i-1");
    expect(JSON.stringify(detail)).not.toContain("arn:secret");
    expect(detail?.runs).toHaveLength(1);
    expect(detail?.state).toBe("blocked");
  });

  it("reports provision states and never turns a failure into a box", () => {
    expect(parseProvision(ok({ status: "pending", attemptId: "try-1" }))).toEqual({ status: "pending", attemptId: "try-1" });
    expect(parseProvision(ok({ status: "already_exists", outpostId: "demo-1" }))).toEqual({ status: "already_exists", outpostId: "demo-1" });
    const failure = parseProvision(ok({ status: "failure", outpostId: "half", error: "ec2 failed" }));
    expect(failure).toEqual({ status: "failure", message: failureCopy() });
    expect(listAfterProvision([], failure).map((item) => item.id)).toEqual([]);
    expect(listAfterProvision([
      { id: "keep", name: "main", state: "running", lastSeenAt: null, jobsCount: 0, jobHealth: emptyHealth() },
    ], failure)).toHaveLength(1);
  });

  it("refuses provision and manage when the person cannot manage, without calling the API", async () => {
    const provision = vi.fn(async () => ok({ status: "success", outpostId: "nope", name: "nope", state: "ready" }));
    const rename = vi.fn(async () => ok({}));
    const remove = vi.fn(async () => ok({}));
    const client = createCompanyOutpostClient({
      companyUid: "cmp_1",
      canManage: false,
      api: {
        listCompanyOutposts: async () => ok({ outposts: [] }),
        provisionCompanyOutpost: provision,
        renameCompanyOutpost: rename,
        removeCompanyOutpost: remove,
      },
    });
    expect(await client.provision()).toEqual({ status: "forbidden" });
    expect(await client.rename("demo-1", "quiet-pine")).toMatchObject({ ok: false });
    expect(await client.remove("demo-1")).toMatchObject({ ok: false });
    expect(provision).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("lets an admin provision through the company call", async () => {
    const provision = vi.fn(async () => ok({
      status: "success",
      outpost: { outpostId: "demo-new", name: "quiet-pine", state: "preparing", jobsCount: 0 },
    }));
    const client = createCompanyOutpostClient({
      companyUid: "cmp_1",
      canManage: true,
      api: { provisionCompanyOutpost: provision, listCompanyOutposts: async () => ok({ outposts: [] }) },
    });
    const result = await client.provision();
    expect(provision).toHaveBeenCalledWith("cmp_1");
    expect(result.status).toBe("success");
  });

  it("treats a provisioning response as pending and does not add a row", () => {
    const pending = parseProvision(ok({
      outpost: { outpostId: "opc_new", name: "quiet-pine", lifecycle: "provisioning" },
      operationId: "op_1",
    }));
    expect(pending).toEqual({ status: "pending", attemptId: "opc_new" });
    expect(listAfterProvision([], pending)).toEqual([]);
  });

  it("maps a coded unavailable provision to a plain failure", () => {
    const failure = parseProvision({ ok: false, reason: "error", code: "unavailable", message: "no resources changed" });
    expect(failure).toEqual({ status: "failure", message: failureCopy() });
    expect(listAfterProvision([], failure)).toEqual([]);
  });

  it("maps billing_required and payment_not_set_up to the neutral unavailable result", () => {
    expect(parseProvision(ok({ status: "payment_not_set_up" }))).toEqual({ status: "unavailable" });
    expect(parseProvision(ok({ status: "failure", code: "billing_required" }))).toEqual({ status: "unavailable" });
    expect(parseProvision(ok({ status: "billing_required" }))).toEqual({ status: "unavailable" });
    expect(parseProvision(ok({ status: "failure", code: "payment_not_set_up" }))).toEqual({ status: "unavailable" });
    expect(parseProvision({ ok: false, reason: "error", code: "billing_required", message: "x" })).toEqual({ status: "unavailable" });
    expect(parseProvision({ ok: false, reason: "error", code: "402", message: "x" })).toEqual({ status: "unavailable" });
    expect(listAfterProvision([], { status: "unavailable" })).toEqual([]);
  });

  it("maps a ready row that is not signed in to needs attention", () => {
    const parsed = parseCompanyOutpostList({
      outposts: [{ outpostId: "opc_1", lifecycle: "ready", signIn: { signedIn: false, state: "awaiting_sign_in" } }],
    });
    expect(parsed?.items[0]).toMatchObject({ name: "main", state: "needs_attention" });
  });

  it("keeps a 502 or an unknown 5xx provision answer pending", () => {
    expect(parseProvision({ ok: false, reason: "error", code: "http-502", message: "bad gateway" })).toEqual({ status: "pending", attemptId: "" });
    expect(parseProvision({ ok: false, reason: "error", code: "error", message: "x", status: 502 })).toEqual({ status: "pending", attemptId: "" });
  });

  it("does not say the Outpost was not added when the status read fails", () => {
    const checking = { status: "checking", signIn: false };
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "network", message: "offline" })).toEqual(checking);
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "error", message: "x", status: 503 })).toEqual(checking);
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "unavailable", message: "x", status: 503 })).toEqual(checking);
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "http-502", message: "x" })).toEqual(checking);
    expect(parseProvisionStatus({ ok: true, value: { surprise: true } })).toEqual(checking);
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "unauthorized", message: "token expired", status: 401 }))
      .toEqual({ status: "checking", signIn: true });
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "forbidden", message: "x", status: 403 })).toEqual({ status: "forbidden" });
  });

  it("still reports a real failure from the status read", () => {
    expect(parseProvisionStatus({ ok: false, reason: "error", code: "not_found", message: "x", status: 404 }))
      .toEqual({ status: "failure", message: failureCopy() });
    expect(parseProvisionStatus(ok({ status: "failure", outpostId: "half" }))).toEqual({ status: "failure", message: failureCopy() });
    expect(parseProvisionStatus(ok({ outpost: { outpostId: "opc_1", lifecycle: "provisioning" } })))
      .toEqual({ status: "pending", attemptId: "opc_1" });
  });

  it("polls status with the status-read rules", async () => {
    const poll = vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "unauthorized", message: "x", status: 401 }));
    const client = createCompanyOutpostClient({
      companyUid: "cmp_1",
      canManage: true,
      api: { pollCompanyOutpostProvision: poll },
    });
    expect(await client.pollProvision("")).toEqual({ status: "checking", signIn: true });
    expect(poll).toHaveBeenCalledWith("cmp_1", "");
  });

  it("does not offer a sign-in that only asks for a new link", () => {
    const client = createCompanyOutpostClient({ companyUid: "cmp_1", canManage: true, api: {} });
    expect("signInAgain" in client).toBe(false);
  });
});
