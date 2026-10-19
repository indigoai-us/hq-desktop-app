import { describe, expect, it } from "vitest";
import {
  ALERT_AUDIENCE,
  JOBS_COLLECTION_PATH,
  JOBS_STATUS_PATH,
  OUTPOST_JOBS_ROUTE,
  SCHEDULE_PRESETS,
  WATCHDOG_CRON,
  WATCHDOG_NAME,
  WATCHDOG_PROMPT,
  blankJobDraft,
  blockedBoxNote,
  classifyAcceptance,
  displayLabel,
  displayStatus,
  healthFromUnknown,
  NOT_AVAILABLE_COPY,
  isNotAvailableCode,
  isRunnableJob,
  jobFailureCopy,
  mergeJobHealth,
  outpostJobsDestination,
  parseCompanyBoxes,
  parseCompanyJob,
  parseOutpostJobsParam,
  revisionDefinition,
  sanitizeJobBody,
  scheduleError,
  schedulePlainWords,
  validateJobDraft,
  watchdogDraft,
} from "./company-jobs-model.js";

describe("US-004 company job drafts", () => {
  it("says each preset in plain words and rejects a five-field cron", () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(schedulePlainWords(preset.cron), preset.id).toBe(preset.label);
      expect(scheduleError(preset.cron), preset.id).toBe("");
    }
    expect(schedulePlainWords("cron(0 9 ? * MON-FRI *)")).toBe("Every weekday at 9:00");
    expect(schedulePlainWords("cron(0 8,20 * * ? *)")).toBe("Every day at 8:00 and 20:00");
    expect(schedulePlainWords(WATCHDOG_CRON)).toBe("Every day at 8:00 and 20:00");
    expect(scheduleError(WATCHDOG_CRON)).toBe("");
    expect(schedulePlainWords("rate(12 hours)")).toBe("Every 12 hours");
    expect(schedulePlainWords("rate(1 day)")).toBe("Every day");
    expect(schedulePlainWords("rate(1 hour)")).toBe("Every hour");
    expect(schedulePlainWords("cron(0,10 * * * ? *)")).toBe("Custom schedule");
    expect(scheduleError("0 8,20 * * *")).toBe(
      "That schedule was not accepted. Use an EventBridge cron or rate expression.",
    );
    expect(scheduleError("cron(*/1 * * * ? *)")).toBe(
      "Recurring jobs may not run more often than every 5 minutes.",
    );
    expect(scheduleError("cron(0,2 * * * ? *)")).toBe(
      "Recurring jobs may not run more often than every 5 minutes.",
    );
    expect(scheduleError("cron(0 9 ? * 1 *)")).toBe(
      "That schedule was not accepted. Use an EventBridge cron or rate expression.",
    );
    expect(scheduleError("rate(1 minute)")).toBe(
      "Recurring jobs may not run more often than every 5 minutes.",
    );
    expect(scheduleError("cron(0,10 * * * ? *)")).toBe("");
  });

  it("validates the add-job fields and keeps the watchdog fill editable", () => {
    const draft = blankJobDraft("");
    const errors = validateJobDraft(draft, []);
    expect(errors.name).toBe("Enter a job name.");
    expect(errors.run).toBe("Describe what this job runs.");
    expect(errors.box).toBe("Choose an Outpost.");
    draft.name = "Daily note";
    draft.prompt = "Write the note.";
    draft.boxId = "opc_1";
    expect(validateJobDraft(draft, [])).toEqual({});
    expect(validateJobDraft({ ...draft, name: "daily note" }, ["Daily note"]).name).toBe(
      "That job name is already in use on this Outpost.",
    );
    expect(validateJobDraft({ ...draft, name: "Daily note" }, ["Daily note"], "Daily note")).toEqual({});
    expect(validateJobDraft({ ...draft, mode: "skill", skill: "" }, []).run).toBe("Enter a skill reference.");
    expect(validateJobDraft({ ...draft, mode: "skill", skill: "ok skill" }, []).run).toBe(
      "Enter a skill reference such as weekly-review.",
    );
    expect(validateJobDraft({ ...draft, mode: "skill", skill: "weekly-review" }, []).run).toBeUndefined();
    expect(validateJobDraft({ ...draft, alertAudience: "just-me" }, []).alert).toBe(
      "Alerts go to every current company owner and admin.",
    );
    expect(validateJobDraft({ ...draft, timezone: "Not/AZone" }, []).schedule).toBe(
      "Enter a timezone such as America/New_York.",
    );

    const filled = watchdogDraft("opc_1");
    expect(filled.name).toBe(WATCHDOG_NAME);
    expect(filled.prompt).toBe(WATCHDOG_PROMPT);
    expect(filled.customCron).toBe(WATCHDOG_CRON);
    filled.name = "watchdog-edited";
    filled.prompt = "A different check.";
    expect(validateJobDraft(filled, [])).toEqual({});
    expect(revisionDefinition(filled)).toEqual({
      prompt: "A different check.",
      context: { name: "watchdog-edited" },
      schedule: { kind: "recurring", cron: WATCHDOG_CRON, timezone: "America/New_York" },
    });
    expect(JSON.stringify(revisionDefinition(filled))).not.toMatch(/registered_by|notify|alert/);
  });

  it("posts a revision without a client actor and names the stable route", () => {
    expect(OUTPOST_JOBS_ROUTE).toBe("outpost-jobs");
    expect(JOBS_COLLECTION_PATH).toBe("/outpost/company/jobs");
    expect(JOBS_STATUS_PATH).toBe("/outpost/company/jobs/status");
    expect(outpostJobsDestination("cmp_1", "opc_1")).toEqual({
      kind: "extra",
      page: "outpost-jobs",
      companyUid: "cmp_1",
      param: "outpostId=opc_1&company=cmp_1",
    });
    expect(parseOutpostJobsParam("outpostId=opc_1&company=cmp_1")).toEqual({
      outpostId: "opc_1",
      companyUid: "cmp_1",
    });
    expect(parseOutpostJobsParam("opc_bare")).toEqual({ outpostId: "opc_bare", companyUid: null });
    const body = sanitizeJobBody({
      companyUid: "cmp_1",
      action: "create",
      registered_by: "spoof",
      registeredBy: "spoof",
      actor: "spoof",
      definition: {
        prompt: "hi",
        registered_by: "spoof",
        context: { name: "Hi", notify: ["x"], alert: "member" },
        schedule: { kind: "recurring", cron: WATCHDOG_CRON, timezone: "UTC" },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/spoof|notify|alert/);
    expect(body).toMatchObject({ companyUid: "cmp_1", action: "create" });
  });

  it("treats a revision as accepted only when the response carries acceptedRevision", () => {
    expect(classifyAcceptance({ job: { acceptedRevision: "3" } })).toBe("accepted");
    expect(classifyAcceptance({ job: {} })).toBe("pending");
    expect(classifyAcceptance({ acceptance: "pending", job: { acceptedRevision: "3" } })).toBe("pending");
    expect(isRunnableJob({ accepted: true, paused: false })).toBe(true);
    expect(isRunnableJob({ accepted: false, paused: false })).toBe(false);
    expect(isRunnableJob({ accepted: true, paused: true })).toBe(false);
    expect(isRunnableJob({ accepted: true, paused: false, deleted: true })).toBe(false);
  });
});

describe("US-006 job health words", () => {
  it("never shows an unknown or paused job as ran on time", () => {
    expect(healthFromUnknown("ok")).toBe("ok");
    expect(healthFromUnknown("surprise")).toBe("unknown");
    expect(displayStatus(false, "ok")).toBe("ok");
    expect(displayLabel("ok")).toBe("Ran on time");
    expect(displayStatus(true, "ok")).toBe("paused");
    expect(displayLabel("paused")).toBe("Paused");
    expect(displayStatus(true, "missed")).toBe("missed");
    expect(displayStatus(false, "stale")).toBe("stale");
    expect(displayStatus(false, "blocked")).toBe("blocked");
    expect(displayLabel("unknown")).toBe("Unknown");
    expect(displayLabel(displayStatus(false, healthFromUnknown("fine")))).toBe("Unknown");
    const job = parseCompanyJob({
      jobId: "job_1",
      prompt: "Check",
      status: "paused",
      acceptedRevision: "2",
      agentUid: "opc_1",
      schedule: { cron: "cron(0 9 ? * MON-FRI *)", timezone: "UTC" },
      context: { name: "Weekday" },
      registeredBy: "prs_a",
    });
    expect(job?.accepted).toBe(true);
    const [listed] = mergeJobHealth(
      [job!],
      [{ jobId: "job_1", status: "ok", lastRunAt: null, nextRunAt: "2026-10-19T13:00:00.000Z", message: "", nextStep: "" }],
    );
    expect(listed.displayLabel).toBe("Paused");
    expect(listed.nextRunAt).toBeNull();
    expect(listed.scheduleLabel).toBe("Every weekday at 9:00");
  });

  it("uses the contract refusal sentences and the blocked-box notes", () => {
    expect(jobFailureCopy("admin_required")).toBe("Only company owners and admins can do this.");
    expect(jobFailureCopy("box_not_signed_in")).toBe("Sign this Outpost in to Claude before adding or running jobs.");
    expect(jobFailureCopy("revision_not_accepted")).toBe("Someone else changed this job. Reload it and try again.");
    expect(jobFailureCopy("unsupported_schedule")).toBe("That schedule is not supported. Pick a longer interval.");
    expect(jobFailureCopy("invalid_definition")).toBe("Check the prompt and schedule, then try again.");
    expect(jobFailureCopy("company_jobs_unavailable")).toBe("Could not load. Retry");
    expect(jobFailureCopy("feature_disabled")).toBe("Company Outposts are paused right now. Try again later.");
    expect(jobFailureCopy("job_not_found")).toBe("This job was removed.");
    const box = { id: "opc_1", name: "main", blocked: true };
    expect(blockedBoxNote(box, true)).toBe(
      "This Outpost needs attention. Scheduled jobs are paused. HQ has been notified and will follow up by email.",
    );
    expect(blockedBoxNote(box, false)).toBe(
      "This Outpost needs attention. Scheduled jobs are paused. An owner or admin has been notified.",
    );
    expect(parseCompanyBoxes({
      outposts: [
        { outpostId: "opc_1", name: "ridge", lifecycle: "blocked" },
        { outpostId: "opc_2", lifecycle: "stopped" },
        { outpostId: "opc_3", name: "old", lifecycle: "destroyed" },
      ],
    })).toEqual([
      { id: "opc_1", name: "ridge", blocked: true, stopped: false },
      { id: "opc_2", name: "main", blocked: false, stopped: true },
    ]);
    expect(parseCompanyBoxes({ outpost: { outpostId: "outpost_cmp_1", lifecycle: "ready" } })).toEqual([
      { id: "outpost_cmp_1", name: "main", blocked: false, stopped: false },
    ]);
    expect(blockedBoxNote({ id: "opc_1", name: "main", stopped: true }, true)).toBe(
      "This Outpost is stopped. Scheduled jobs are paused until it is started.",
    );
    expect(ALERT_AUDIENCE).toBe("admins");
  });
});

describe("not available yet state", () => {
  it("maps billing_required and payment-not-set-up codes to one neutral line", () => {
    expect(NOT_AVAILABLE_COPY).toBe("Outposts are not available for this company yet.");
    for (const code of ["billing_required", "payment_not_set_up", "payment_required", "payment_method_required"]) {
      expect(isNotAvailableCode(code)).toBe(true);
      expect(jobFailureCopy(code)).toBe(NOT_AVAILABLE_COPY);
    }
    expect(isNotAvailableCode("company_jobs_unavailable")).toBe(false);
    expect(isNotAvailableCode("")).toBe(false);
  });

  it("marks a box blocked for billing as unavailable and gives it no blocked note", () => {
    const boxes = parseCompanyBoxes({
      outposts: [
        { outpostId: "opc_1", name: "ridge", lifecycle: "blocked", blockedReason: "billing_required" },
        { outpostId: "opc_2", name: "other", lifecycle: "blocked", blockedReason: "outcome_unknown" },
      ],
    });
    expect(boxes).toEqual([
      { id: "opc_1", name: "ridge", blocked: true, stopped: false, unavailable: true },
      { id: "opc_2", name: "other", blocked: true, stopped: false },
    ]);
    expect(blockedBoxNote(boxes[0], true)).toBeNull();
    expect(blockedBoxNote(boxes[0], false)).toBeNull();
    expect(blockedBoxNote(boxes[1], true)).toContain("This Outpost needs attention.");
  });
});
