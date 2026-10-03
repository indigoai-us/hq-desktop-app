import { describe, expect, it } from "vitest";
import {
  brainListView,
  filterPolicies,
  filterSkills,
  filterWorkers,
  metadata,
  policyCreatePrompt,
  policyFromFile,
  skillCreatePrompt,
  skillRunPrompt,
  virtualWindow,
  workerCreatePrompt,
  workerRunPrompt,
  VIRTUAL_AFTER,
  type PolicyDoc,
  type SkillRow,
  type WorkerRow,
} from "./brain-model.js";

describe("US-028 brain model", () => {
  it("keeps the scroll budget inside one percent", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
  });

  it("windows lists past 200 rows and keeps short lists whole", () => {
    expect(virtualWindow(12, 0, 400)).toEqual({ start: 0, end: 12, padTop: 0, padBottom: 0 });
    const windowed = virtualWindow(VIRTUAL_AFTER + 40, 62 * 20, 400);
    expect(windowed.start).toBeGreaterThan(0);
    expect(windowed.end).toBeLessThan(VIRTUAL_AFTER + 40);
  });

  it("prefills Run with the skill slash and the worker run command", () => {
    expect(skillRunPrompt("standup-brief")).toBe("/standup-brief");
    expect(workerRunPrompt("deal-brain")).toBe("/run deal-brain");
  });

  it("hands create sheets to the existing HQ commands", () => {
    const policy = policyCreatePrompt("indigo", {
      title: "Draft only",
      enforcement: "hard",
      when: "outbound email",
      scope: "company",
      satisfiedBy: "/sync-docs",
      body: "Never send.",
    });
    expect(policy.startsWith("/learn")).toBe(true);
    expect(policy).toContain("companies/indigo/policies/draft-only.md");
    expect(policy).toContain("Do not invent a new file format.");

    const skill = skillCreatePrompt("indigo", {
      name: "Renewal Brief",
      scope: "company",
      triggers: ["renewal brief"],
      template: "brief",
    });
    expect(skill.startsWith("/create-skill")).toBe(true);
    expect(skill).toContain("Name: renewal-brief");

    const worker = workerCreatePrompt("indigo", {
      name: "Pricing Desk",
      scope: "company",
      description: "Rates",
      skills: ["precall-brief"],
      tools: [],
      knowledge: "knowledge/pricing/rate-card.md",
    });
    expect(worker.startsWith("/newworker")).toBe(true);
    expect(worker).toContain("worker.yaml");
  });

  it("reads policy enforcement from existing frontmatter", () => {
    const doc = policyFromFile("companies/indigo/policies/docs.md", [
      "---",
      "title: Docs sync",
      "enforcement: hard",
      "when: material change",
      "---",
      "Keep the docs current.",
    ].join("\n"));
    expect(doc.enforcement).toBe("hard");
    expect(doc.title).toBe("Docs sync");
    expect(doc.body).toContain("Keep the docs current.");
  });

  it("filters skills, workers, and policies in place", () => {
    const skills: SkillRow[] = [
      {
        name: "a", description: "", path: "a", scope: "company", triggers: [],
        owner: "", lastRun: "", runs: 0, running: false, needsAccess: true,
        mine: false, shared: false,
      },
    ];
    expect(filterSkills(skills, "needs-access", "")).toHaveLength(1);
    expect(filterSkills(skills, "mine", "")).toHaveLength(0);
    const workers: WorkerRow[] = [
      {
        id: "w", name: "w", description: "", path: "w", scope: "company",
        tools: [], skills: [], parked: true, mine: true, scheduled: false,
        live: false, lastRun: "",
      },
    ];
    expect(filterWorkers(workers, "all", "active", "")).toHaveLength(0);
    expect(filterWorkers(workers, "company", "parked", "")).toHaveLength(1);
    const policies: PolicyDoc[] = [
      {
        path: "p", title: "Soft one", enforcement: "soft", when: "", scope: "company",
        appliesTo: "", satisfiedBy: "", version: "", createdBy: "", edited: "", body: "",
      },
    ];
    expect(filterPolicies(policies, "hard", "")).toHaveLength(0);
  });
});

describe("QA-100 brain list load states", () => {
  it("shows a skeleton and no count while loading without cached rows", () => {
    expect(brainListView("not-loaded", 0)).toEqual({ body: "skeleton", count: null });
    expect(brainListView("loading", 0)).toEqual({ body: "skeleton", count: null });
  });

  it("shows cached rows and their count while loading", () => {
    expect(brainListView("loading", 825)).toEqual({ body: "rows", count: 825 });
  });

  it("shows the empty state with a zero only once loaded", () => {
    expect(brainListView("loaded", 0)).toEqual({ body: "empty", count: 0 });
    expect(brainListView("loaded", 3)).toEqual({ body: "rows", count: 3 });
  });
});
