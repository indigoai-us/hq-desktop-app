import { describe, expect, it, vi } from "vitest";
import { OUTPOST_PATHS } from "@hq/platform";
import { companyJobsHttpClient, companyJobsStatusPath } from "./company-jobs-client.js";
import { JOBS_COLLECTION_PATH, JOBS_STATUS_PATH } from "./company-jobs-model.js";
import { createCompanyJobStore } from "./company-jobs-stub.js";

const NOW = "2026-10-18T15:00:00.000Z";
const CRON = "cron(0 9 ? * MON-FRI *)";

function definition(name: string, prompt = "Write the weekday note."): Record<string, unknown> {
  return {
    prompt,
    context: { name },
    schedule: { kind: "recurring", cron: CRON, timezone: "America/New_York" },
  };
}

describe("US-004 company job revisions", () => {
  it("audits admin A creating a job and admin B updating and running it, under their own ids", async () => {
    const store = createCompanyJobStore({ now: () => NOW });
    const adminA = store.client({ uid: "prs_admin_a", role: "admin" });
    const adminB = store.client({ uid: "prs_admin_b", role: "admin" });
    const created = await adminA.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: {
        ...definition("Weekday note"),
        registered_by: "prs_spoof",
        context: { name: "Weekday note", notify: ["spoof"], alert: "member" },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.acceptance).toBe("accepted");
    expect(created.job?.registeredBy).toBe("prs_admin_a");
    expect(created.job?.revision).toBe("1");
    const posted = store.requests[0]?.body;
    expect(JSON.stringify(posted)).not.toMatch(/registered_by|prs_spoof|notify|alert/);

    const updated = await adminB.submit({
      companyUid: "cmp_1",
      action: "update",
      outpostId: "opc_1",
      jobId: created.job?.jobId,
      revision: created.job?.revision,
      definition: definition("Weekday note", "Write a shorter note."),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok || !updated.job) return;
    expect(updated.job.latestEditor).toBe("prs_admin_b");
    expect(updated.job.prompt).toBe("Write a shorter note.");
    expect(updated.job.revision).toBe("2");

    const ran = await adminB.submit({
      companyUid: "cmp_1",
      action: "run-now",
      jobId: updated.job.jobId,
      revision: updated.job.revision,
    });
    expect(ran).toMatchObject({ ok: true, acceptance: "accepted" });
    expect(store.runs.map((run) => run.actor)).toEqual(["prs_admin_b"]);
    expect(store.audit.map((row) => [row.actor, row.action])).toEqual([
      ["prs_admin_a", "create"],
      ["prs_admin_b", "update"],
      ["prs_admin_b", "run-now"],
    ]);
    expect(store.runnablePrompts()).toEqual(["Write a shorter note."]);
  });

  it("accepts an owner revision under that owner's id", async () => {
    const store = createCompanyJobStore({ now: () => NOW });
    const owner = store.client({ uid: "prs_owner", role: "owner" });
    const created = await owner.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Owner note"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.acceptance).toBe("accepted");
    expect(created.job?.registeredBy).toBe("prs_owner");
    expect(store.audit.map((row) => row.actor)).toEqual(["prs_owner"]);
  });

  it("does not call the route when the caller cannot manage jobs, and a member write is refused", async () => {
    const store = createCompanyJobStore({ now: () => NOW });
    const calls = vi.fn(async () => ({ ok: true, status: 201, code: "", body: { job: {} } }));
    const blocked = companyJobsHttpClient({ request: calls }, { writesAllowed: false });
    const refused = await blocked.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Nope"),
    });
    expect(refused).toEqual({ ok: false, code: "admin_required" });
    expect(calls).not.toHaveBeenCalled();

    const member = store.client({ uid: "prs_member", role: "member" }, { writesAllowed: true, memberRead: false });
    const memberWrite = await member.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Nope"),
    });
    expect(memberWrite).toEqual({ ok: false, code: "admin_required" });
    expect(store.jobs).toHaveLength(0);
    expect(store.audit).toHaveLength(0);
  });

  it("keeps an unaccepted revision pending and not runnable", async () => {
    const store = createCompanyJobStore({ now: () => NOW, autoAccept: false });
    const admin = store.client({ uid: "prs_admin_a", role: "admin" });
    const created = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Waiting note"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok || !created.job) return;
    expect(created.acceptance).toBe("pending");
    expect(created.job.accepted).toBe(false);
    expect(store.runnablePrompts()).toEqual([]);
    const ran = await admin.submit({
      companyUid: "cmp_1",
      action: "run-now",
      jobId: created.job.jobId,
      revision: "1",
    });
    expect(ran).toEqual({ ok: false, code: "revision_not_accepted" });
    expect(store.runs).toHaveLength(0);
  });

  it("does not execute a vault edit that the server has not accepted", async () => {
    const store = createCompanyJobStore({ now: () => NOW });
    const admin = store.client({ uid: "prs_admin_a", role: "admin" });
    const created = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Accepted", "Run the accepted prompt."),
    });
    if (!created.ok || !created.job) throw new Error("create failed");
    store.vaultEdit(created.job.jobId, "This shadow prompt must not run.");
    expect(store.runnablePrompts()).toEqual(["Run the accepted prompt."]);
    const listed = await admin.list("cmp_1");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.jobs[0]?.prompt).toBe("Run the accepted prompt.");
  });

  it("binds the desktop paths to the platform route table", () => {
    expect(JOBS_COLLECTION_PATH).toBe(OUTPOST_PATHS.companyJobs);
    expect(JOBS_STATUS_PATH).toBe("/outpost/company/jobs/status");
    expect(companyJobsStatusPath("cmp_1", "opc 1")).toBe(OUTPOST_PATHS.companyJobsStatus("cmp_1", "opc 1"));
    expect(companyJobsStatusPath("cmp_1")).toBe("/outpost/company/jobs/status?companyUid=cmp_1");
  });
});

describe("US-006 company job health reads", () => {
  it("keeps the job list when the health read fails", async () => {
    const store = createCompanyJobStore({ now: () => NOW });
    const admin = store.client({ uid: "prs_admin_a", role: "admin" });
    await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Weekday note"),
    });
    store.failStatus = true;
    const listed = await admin.list("cmp_1");
    const health = await admin.status("cmp_1");
    expect(listed.ok).toBe(true);
    expect(health).toEqual({ ok: false, code: "company_job_freshness_unavailable" });
  });

  it("can read health when the job list itself is refused", async () => {
    const store = createCompanyJobStore({ now: () => NOW });
    const admin = store.client({ uid: "prs_admin_a", role: "admin" });
    const created = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Weekday note"),
    });
    if (!created.ok || !created.job) throw new Error("create failed");
    store.setHealth(created.job.jobId, { health: "missed", message: "No completion." });
    store.failList = true;
    const listed = await admin.list("cmp_1");
    const health = await admin.status("cmp_1", "opc_1");
    expect(listed.ok).toBe(false);
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.jobs[0]).toMatchObject({ status: "missed", message: "No completion." });
  });
});
