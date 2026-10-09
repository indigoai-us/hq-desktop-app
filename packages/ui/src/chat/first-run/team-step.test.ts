import { describe, expect, it, vi } from "vitest";

import type { Workspace } from "../workspaces.js";
import {
  companyNameIssue,
  companySlugFromName,
  createTeamActionRunner,
  defaultTeamChoice,
  defaultTeamPick,
  teamHandoff,
  teamOptionsFrom,
  teamSummary,
  type TeamActionResult,
  type TeamActionState,
} from "./team-step.js";

function ws(slug: string, status: string | null, extra: Partial<Workspace> = {}): Workspace {
  return {
    slug,
    displayName: slug.toUpperCase(),
    kind: slug === "personal" ? "personal" : "company",
    state: status === "pending" ? "cloud-only" : "synced",
    cloudUid: `cmp_${slug}`,
    bucketName: null,
    hasLocalFolder: true,
    localPath: null,
    membershipStatus: status,
    role: null,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...extra,
  };
}

describe("team options from the roster", () => {
  it("splits pending invites from companies the person belongs to, never offering the personal vault", () => {
    const options = teamOptionsFrom([
      ws("personal", null, { state: "personal" }),
      ws("acme", "pending"),
      ws("harbor", "active"),
      ws("harbor", "active"),
      ws("cedar", null, { state: "local-only", cloudUid: null }),
      ws("personal", "active", { kind: "company", state: "cloud-only" }),
    ]);
    expect(options.invites.map((c) => c.slug)).toEqual(["acme"]);
    expect(options.companies.map((c) => c.slug)).toEqual(["harbor", "cedar"]);
    expect(options.companies[1]!.companyUid).toBeNull();
    expect(teamOptionsFrom(null)).toEqual({ invites: [], companies: [] });
  });

  it("defaults to the one company the person is in, else Just me; an invite is never accepted by default", () => {
    const one = teamOptionsFrom([ws("harbor", "active"), ws("acme", "pending")]);
    expect(defaultTeamChoice(one)).toEqual({ kind: "company", how: "existing", company: one.companies[0] });
    expect(defaultTeamPick(one)).toEqual({ kind: "existing", company: one.companies[0] });
    expect(defaultTeamChoice(teamOptionsFrom([ws("acme", "pending")]))).toEqual({ kind: "personal" });
    expect(defaultTeamChoice(teamOptionsFrom([ws("a", "active"), ws("b", "active")]))).toEqual({ kind: "personal" });
  });

  it("hands off and summarises each choice", () => {
    const company = { companyUid: "cmp_a", slug: "acme", name: "Acme" };
    expect(teamHandoff({ kind: "personal" })).toEqual({ kind: "personal" });
    expect(teamHandoff({ kind: "company", how: "created", company })).toEqual({ kind: "company", how: "created", name: "Acme", slug: "acme" });
    expect(teamSummary(null)).toBe("Just me");
    expect(teamSummary({ kind: "company", how: "joined", company })).toBe("Joined Acme");
    expect(teamSummary({ kind: "company", how: "created", company })).toBe("Started Acme");
    expect(teamSummary({ kind: "company", how: "existing", company })).toBe("Acme");
  });
});

describe("company names", () => {
  it("makes the handle the create card needs from the typed name", () => {
    expect(companySlugFromName("Pickle Works")).toBe("pickle-works");
    expect(companySlugFromName("  Café  Olé!! ")).toBe("cafe-ole");
    expect(companySlugFromName("42 Labs")).toBe("labs");
    expect(companySlugFromName("A")).toBeNull();
    expect(companySlugFromName("x".repeat(80))).toHaveLength(40);
  });

  it("says why a name cannot be used", () => {
    expect(companyNameIssue("")).toBe("Give your company a name.");
    expect(companyNameIssue("Ok")).not.toBeNull();
    expect(companyNameIssue("Acme Robotics")).toBeNull();
    expect(companyNameIssue("a".repeat(61))).toBe("Keep the name under 60 characters.");
  });
});

describe("one join or create at a time", () => {
  it("shows running at once, ignores repeat presses, and does not run a finished card again", async () => {
    const states: TeamActionState[] = [];
    let resolve!: (r: TeamActionResult) => void;
    const action = vi.fn(() => new Promise<TeamActionResult>((r) => (resolve = r)));
    const runner = createTeamActionRunner((s) => states.push(s));
    runner.run("invite:acme", "Joining Acme…", action);
    expect(runner.current()).toEqual({ state: "running", key: "invite:acme", label: "Joining Acme…" });
    runner.run("invite:acme", "Joining Acme…", action);
    runner.run("create", "Starting X…", action);
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    resolve({ ok: true, choice: { kind: "personal" } });
    await vi.waitFor(() => expect(runner.current().state).toBe("done"));
    runner.run("invite:acme", "Joining Acme…", action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(states.map((s) => s.state)).toEqual(["running", "done"]);
  });

  it("a failure keeps the reason; Retry runs the same action again; a throw is a plain sentence", async () => {
    const action = vi
      .fn<() => Promise<TeamActionResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "Your plan limit is reached." })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, choice: { kind: "personal" } });
    const runner = createTeamActionRunner(() => undefined);
    runner.run("invite:acme", "Joining Acme…", action);
    await vi.waitFor(() => expect(runner.current()).toMatchObject({ state: "failed", reason: "Your plan limit is reached." }));
    runner.retry();
    await vi.waitFor(() => expect(runner.current()).toMatchObject({ state: "failed", reason: "That did not work. Try again in a moment." }));
    runner.retry();
    await vi.waitFor(() => expect(runner.current().state).toBe("done"));
    expect(action).toHaveBeenCalledTimes(3);
  });

  it("clear forgets a failure when the person picks another card", async () => {
    const runner = createTeamActionRunner(() => undefined);
    runner.run("create", "Starting…", async () => ({ ok: false, reason: "No." }));
    await vi.waitFor(() => expect(runner.current().state).toBe("failed"));
    runner.clear();
    expect(runner.current()).toEqual({ state: "idle" });
  });
});
