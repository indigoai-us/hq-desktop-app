import { describe, expect, it } from "vitest";
import { actionItemPrompt, briefPrompts, decisionPrompt, incidentPrompt, waitingPrompt } from "./brief-prompts.js";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";

const day = octoberEightBrief(new Date("2026-10-08T14:40:00Z"));

describe("brief prompts", () => {
  it("builds a context-rich release prompt from the decision's detail", () => {
    const p = decisionPrompt(day.decisions[0]!);
    expect(p).toContain("Cut the hq-core release.");
    expect(p).toContain("staging main 703ed7563");
    expect(p).toContain("PRs 1150 to 1167");
    expect(p).toContain("First check: Stefan flagged the red skill-metadata check");
    expect(p).toContain("Clearing it unlocks: Docs PR 64 can merge; Glossary rename reaches users.");
    expect(p).toContain("Repo or source: indigoai-us/hq-core.");
    expect(p).toMatch(/confirm with me before any irreversible step/);
  });

  it("asks for a recommendation between the two choices on a decide item", () => {
    const p = decisionPrompt(day.decisions[2]!);
    expect(p).toMatch(/^Help me decide: Keep the no-self-merge rule\?/);
    expect(p).toContain("The options are Keep or Retire.");
  });

  it("drafts replies and nudges without sending them", () => {
    expect(decisionPrompt(day.decisions[3]!)).toContain("Do not send it.");
    const nudge = waitingPrompt(day.waitingOn[1]!);
    expect(nudge).toContain("I am waiting on Hassaan to review PR 1201.");
    expect(nudge).toContain("Do not send it");
  });

  it("names the measure and the fix PRs on an incident", () => {
    const p = incidentPrompt({
      id: "fleet",
      title: "Fleet boxes stuck",
      summary: "Disks are full.",
      severity: "incident",
      measure: { healthy: 9, total: 95, unit: "boxes", cause: "STUCK · DISK FULL" },
      links: [
        { label: "hq-cloud/913", origin: { companyUid: null, repo: null } },
        { label: "hq-pro-agents/1132", origin: { companyUid: null, repo: null } },
      ],
      origin: { companyUid: null, repo: "indigoai-us/hq-cloud" },
    });
    expect(p).toContain("86 of 95 boxes are affected (stuck · disk full).");
    expect(p).toContain("Fixes in review: hq-cloud/913, hq-pro-agents/1132.");
  });

  it("builds the real red-CI incident prompt from the sweep fixture", () => {
    const p = incidentPrompt(day.risks[0]!);
    expect(p).toContain("Investigate the live incident: hq-desktop-app main CI red.");
    expect(p).toContain("CI failing on main (1 of 3 workflows).");
    expect(p).toContain("Repo or source: indigoai-us/hq-desktop-app.");
  });

  it("works with a bare decision that has no detail", () => {
    const p = decisionPrompt({ id: "x", title: "Approve the plan", summary: "", action: "go", origin: { companyUid: null, repo: null } });
    expect(p).toBe("Approve the plan. Walk the steps, run the checks, and get it ready. Read what you need first. Stop and confirm with me before any irreversible step (merge, release, publish, deploy, or sending a message).");
    expect(actionItemPrompt({ id: "a", title: "Send the memo", origin: { companyUid: null, repo: "Sales sync" } })).toContain("Repo or source: Sales sync.");
  });

  it("gives every actionable item a prompt in the generator output", () => {
    const plan = generateBrief(day);
    const ids = [...day.decisions, ...day.risks, ...day.waitingOn, ...day.actionItems].map((x) => x.id);
    expect(Object.keys(plan.prompts).sort()).toEqual(ids.sort());
    expect(briefPrompts(day)).toEqual(plan.prompts);
  });
});
