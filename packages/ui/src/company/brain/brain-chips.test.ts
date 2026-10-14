// Owner asks (2026-10-06): more visual hierarchy on Policies, Skills and
// Workers rows; tags as chips with icons; the detail shows a compact header
// card instead of a raw frontmatter dump.

import { describe, expect, it } from "vitest";
import {
  bodyWithoutTitle,
  frontmatterList,
  knowledgeHeader,
  policyHeader,
  policyRowChips,
  policyScope,
  skillRowChips,
  skillSummary,
  tagIcon,
  whenTags,
  workerRowChips,
} from "./brain-chips.js";
import { knowledgeFromFile, policyFromFile, skillRowFromLibrary, workerRowFromLibrary } from "./brain-model.js";

describe("frontmatter lists", () => {
  it("reads inline, comma and block lists", () => {
    expect(frontmatterList("---\ntags: [deploy, \"security\"]\n---\nx", "tags")).toEqual(["deploy", "security"]);
    expect(frontmatterList("---\ntags: a, b, a\n---\n", "tags")).toEqual(["a", "b"]);
    expect(frontmatterList("---\ntitle: T\ntags:\n  - one\n  - 'two'\nwhen: x\n---\n", "tags")).toEqual(["one", "two"]);
    expect(frontmatterList("no frontmatter", "tags")).toEqual([]);
    expect(frontmatterList("﻿---\r\ntags: [crlf]\r\n---\r\n", "tags")).toEqual(["crlf"]);
  });
});

describe("document body", () => {
  it("drops a leading heading that repeats the title, and nothing else", () => {
    expect(bodyWithoutTitle("# Pricing\n\nFree to start.", "Pricing")).toBe("Free to start.");
    expect(bodyWithoutTitle("# Rule\n\nBody", "Deploy gate")).toBe("# Rule\n\nBody");
    expect(bodyWithoutTitle("Intro\n# Pricing", "Pricing")).toBe("Intro\n# Pricing");
  });
});

describe("tag icons", () => {
  it("maps tags to outline icons deterministically, with a fallback", () => {
    expect(tagIcon("security")).toBe("key");
    expect(tagIcon("Deploy")).toBe("cloud");
    expect(tagIcon("slack")).toBe("plug");
    expect(tagIcon("design")).toBe("eye");
    expect(tagIcon("zzz-unknown")).toBe("circle-dot");
    expect(tagIcon("security")).toBe(tagIcon("security"));
  });
});

describe("policy rows", () => {
  const doc = policyFromFile(
    "companies/acme/policies/deploy-gate.md",
    "---\ntitle: Deploy gate\nenforcement: hard\nwhen: deploy, release\ntags: [infra]\nversion: 2\n---\n# Rule\n\nBody",
  );

  it("shows enforcement as a toned chip and the scope, not the path", () => {
    expect(policyRowChips(doc)).toEqual([{ label: "hard", tone: "hard" }, { label: "company" }]);
    expect(policyScope({ path: "core/policies/x.md", scope: "company" })).toBe("core");
    expect(policyScope({ path: "personal/policies/x.md", scope: "" })).toBe("personal");
    expect(policyScope({ path: "companies/a/policies/x.md", scope: "project" })).toBe("company");
  });

  it("splits when triggers into tags", () => {
    expect(whenTags("deploy, release")).toEqual(["deploy", "release"]);
    expect(whenTags("[a | b]")).toEqual(["a", "b"]);
    expect(whenTags("")).toEqual([]);
  });

  it("maps frontmatter into the header card", () => {
    const header = policyHeader(doc);
    expect(header.title).toBe("Deploy gate");
    expect(header.path).toBe("companies/acme/policies/deploy-gate.md");
    expect(header.chips.map((c) => c.label)).toEqual(["hard", "company", "v2"]);
    expect(header.tags.map((c) => [c.label, c.icon])).toEqual([
      ["deploy", "arrow-right"],
      ["release", "arrow-right"],
      ["infra", "cloud"],
    ]);
    expect(doc.body.startsWith("---")).toBe(false);
  });

  it("shows a tag that repeats a trigger once", () => {
    const both = policyFromFile("p/x.md", "---\ntitle: X\nwhen: deploy\ntags: [deploy, qa]\n---\n");
    expect(policyHeader(both).tags.map((c) => c.label)).toEqual(["deploy", "qa"]);
  });
});

describe("knowledge header", () => {
  it("maps title, path, fields and tags", () => {
    const file = knowledgeFromFile(
      "companies/acme/knowledge/gtm/pricing.md",
      "---\ntitle: Pricing\ntype: reference\nstatus: draft\nupdated: 2026-10-02\ntags:\n  - pricing\n  - research\n---\n# Pricing\n",
    );
    const header = knowledgeHeader(file);
    expect(header.title).toBe("Pricing");
    expect(header.chips.map((c) => c.label)).toEqual(["type reference", "status draft", "updated 2026-10-02"]);
    expect(header.tags.map((c) => c.label)).toEqual(["pricing", "research"]);
    expect(header.tags[1]!.icon).toBe("search");
  });

  it("does not repeat a new/updated status as a field", () => {
    const file = knowledgeFromFile("k/a.md", "---\ntitle: A\nstatus: new\n---\n");
    expect(knowledgeHeader(file).chips.map((c) => c.label)).toEqual(["new"]);
  });
});

describe("skill rows", () => {
  it("lifts SCAFFOLD and Blocked into chips and drops them from the description", () => {
    const s = skillSummary("SCAFFOLD. Read one client's store orders. Blocked until a read-only Shopify token is bound.");
    expect(s).toEqual({
      description: "Read one client's store orders.",
      scaffold: true,
      blocked: "Blocked until a read-only Shopify token is bound.",
    });
    expect(skillSummary("Plain description.")).toEqual({ description: "Plain description.", scaffold: false, blocked: null });
  });

  it("shows scaffold, blocked, runs, last run and owning company", () => {
    const row = skillRowFromLibrary(
      { name: "commerce-truth", description: "SCAFFOLD. Reads orders. Blocked until a token is bound.", scope: "company", company: "indigo", path: "p", allowedTools: [] },
      "indigo",
    );
    expect(skillRowChips(row, { runs: 3, lastDay: "2026-10-05" }).map((c) => c.label)).toEqual([
      "scaffold",
      "blocked",
      "3 runs",
      "last 2026-10-05",
      "indigo",
    ]);
    expect(skillRowChips(row).map((c) => c.label)).toEqual(["scaffold", "blocked", "indigo"]);
  });
});

describe("worker rows", () => {
  it("shows status, type, team, skill count and model when known", () => {
    const row = workerRowFromLibrary({ id: "w", name: "W", type: "dev", description: "", scope: "company", status: "active", path: "companies/a/workers/w", team: "dev-team" });
    expect(workerRowChips(row).map((c) => c.label)).toEqual(["Active", "dev", "dev-team"]);
    expect(workerRowChips({ ...row, skillCount: 4, model: "opus" }).map((c) => c.label)).toEqual(["Active", "dev", "dev-team", "4 skills", "opus"]);
    expect(workerRowChips({ ...row, parked: true, status: "parked" })[0]).toEqual({ label: "Parked", tone: "idle" });
  });
});
