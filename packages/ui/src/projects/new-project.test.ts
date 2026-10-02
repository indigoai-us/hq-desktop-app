import { describe, expect, it } from "vitest";
import type { Objective } from "./local-projects.js";
import { linkPickerOptions, newProjectPrompt, projectSlug } from "./new-project.js";

const goal: Objective = {
  id: "desktop",
  title: "Desktop Experience",
  description: "",
  status: "active",
  timeframe: "Q4",
  keyResults: [{ id: "kr1", title: "Ship the Console rail" }],
  initiativeIds: [],
};

describe("new project sheet model", () => {
  it("slugs the name into a project id", () => {
    expect(projectSlug("  HQ Desktop Widget! ")).toBe("hq-desktop-widget");
  });

  it("builds a brainstorm prompt with repo, owner, and linked KR", () => {
    const [, kr] = linkPickerOptions([goal]);
    const prompt = newProjectPrompt({
      name: "HQ Desktop Widget",
      company: "indigo",
      location: "repo",
      repo: "repos/private/hq-desktop-app",
      owner: "Corey",
      link: kr,
      start: "brainstorm",
    });
    expect(prompt.split("\n")[0]).toBe("/brainstorm hq-desktop-widget");
    expect(prompt).toContain("indigo/projects/hq-desktop-widget");
    expect(prompt).toContain("Repo: repos/private/hq-desktop-app");
    expect(prompt).toContain("Linked goal: Desktop Experience › Ship the Console rail");
    expect(prompt).toContain("Not started");
  });

  it("vault-only blank start has no slash command", () => {
    const prompt = newProjectPrompt({
      name: "x",
      company: "indigo",
      location: "vault",
      repo: "r",
      owner: "",
      link: null,
      start: "blank",
    });
    expect(prompt.startsWith("Create the HQ project")).toBe(true);
    expect(prompt).toContain("Vault only");
  });

  it("filters goals and KRs for the link picker", () => {
    expect(linkPickerOptions([goal]).map((o) => o.kind)).toEqual(["goal", "kr"]);
    expect(linkPickerOptions([goal], "console").map((o) => o.id)).toEqual([
      "desktop#kr1",
    ]);
  });
});

describe("New project company tabs (QA-050)", () => {
  it("uses the rail roster, Personal first, and drops local-only companies", async () => {
    const { companyPickerSlugs } = await import("../shell/pinned-companies.js");
    const { newProjectCompanies, newProjectDefaultCompany } = await import("./new-project.js");
    const roster = companyPickerSlugs([
      { kind: "personal", slug: "personal", cloudUid: "prs_1" },
      { kind: "company", slug: "indigo", cloudUid: "cmp_1" },
      { kind: "company", slug: "workspace", cloudUid: null },
      { kind: "company", slug: "tonal", cloudUid: "  " },
      { kind: "company", slug: "postpilot", cloudUid: "cmp_2" },
    ]);
    expect(roster).toEqual(["personal", "indigo", "postpilot"]);
    const tabs = newProjectCompanies("tonal", roster, ["tonal", "magical-moments"]);
    expect(tabs).toEqual(["personal", "indigo", "postpilot"]);
    expect(newProjectDefaultCompany("tonal", tabs)).toBe("personal");
    expect(newProjectDefaultCompany("indigo", tabs)).toBe("indigo");
  });

  it("falls back to the current company plus project companies without a roster", async () => {
    const { newProjectCompanies } = await import("./new-project.js");
    expect(newProjectCompanies("indigo", null, ["indigo", "acme", null, "acme"])).toEqual([
      "indigo",
      "acme",
    ]);
  });
});
