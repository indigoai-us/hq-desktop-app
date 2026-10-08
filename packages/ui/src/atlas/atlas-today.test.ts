import { describe, expect, it } from "vitest";
import { atlasAgo, atlasHumanTitle, atlasTodayChanges, atlasTodayGroups, atlasTodayKind } from "./atlas-today.js";
import type { AtlasNode } from "./atlas-model.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const n = (id: string, type: AtlasNode["type"], touched?: number): AtlasNode => ({ id, type, label: id, path: id, folder: false, count: 1, touched });
const at = (type: AtlasNode["type"], path: string, extra: Partial<AtlasNode> = {}): AtlasNode => ({
  id: `${type}:${path}`,
  type,
  label: path,
  path,
  folder: path.endsWith("/"),
  count: 1,
  touched: NOW - 34 * 60_000,
  ...extra,
});

describe("Today panel contents", () => {
  it("lists objects changed today, projects first, then newest", () => {
    const nodes = [
      n("k-new", "knowledge", NOW - 60_000),
      n("p-old-today", "project", Date.UTC(2026, 8, 30, 1)),
      n("p-new", "project", NOW - 5 * 60_000),
      n("yesterday", "project", Date.UTC(2026, 8, 29, 23, 59)),
      n("future", "repo", NOW + 60_000),
      n("undated", "repo"),
    ];
    expect(atlasTodayChanges(nodes, NOW).map((x) => x.id)).toEqual(["p-new", "p-old-today", "k-new"]);
  });

  it("is empty on a quiet day", () => {
    expect(atlasTodayChanges([n("old", "project", NOW - 3 * 86_400_000)], NOW)).toEqual([]);
  });

  it("says how long ago in plain words", () => {
    expect(atlasAgo(NOW - 10_000, NOW)).toBe("just now");
    expect(atlasAgo(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(atlasAgo(NOW - 3 * 3_600_000 - 1, NOW)).toBe("3 h ago");
  });
});

describe("Today panel groups", () => {
  // The output set of one /brainstorm run, inside one project folder.
  const project = at("project", "projects/market-entry/", { stories: { done: 7, total: 15 }, touched: NOW - 2 * 3_600_000 });
  const brainstorm = ["brainstorm.md", "hq-landscape.md", "market-landscape.md", "opportunity-sizing.md", "references.md"].map((f) =>
    at("project", `projects/market-entry/${f}`),
  );

  it("puts a brainstorm run's files under their project, with its stories and board state", () => {
    const nodes = [project, ...brainstorm];
    const groups = atlasTodayGroups(atlasTodayChanges(nodes, NOW), nodes);
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g!.title).toBe("Market entry");
    expect(g!.node?.id).toBe(project.id);
    expect(g!.stories).toMatchObject({ done: 7, total: 15, text: "7 of 15 stories" });
    expect(g!.stories!.fraction).toBeCloseTo(7 / 15);
    expect(g!.column).toBe("in-progress");
    expect(g!.changed).toBe(true);
    expect(g!.rows.map((r) => r.title)).toEqual(["Brainstorm", "HQ landscape", "Market landscape", "Opportunity sizing", "References"]);
    expect(g!.rows.every((r) => r.parentPath === "projects/market-entry/")).toBe(true);
    expect(g!.rows[0]!.kind).toBe("brainstorm");
  });

  it("uses parentId first, and the board column for not started and complete", () => {
    const a = at("project", "projects/a/", { stories: { done: 0, total: 3 } });
    const b = at("project", "projects/b/", { stories: { done: 4, total: 4 } });
    const child = at("knowledge", "knowledge/notes.md", { parentId: b.id });
    const groups = atlasTodayGroups([a, child], [a, b, child]);
    expect(groups.find((g) => g.key === a.id)!.column).toBe("not-started");
    const bg = groups.find((g) => g.key === b.id)!;
    expect(bg.column).toBe("complete");
    expect(bg.changed).toBe(false);
    expect(bg.rows.map((r) => r.node.id)).toEqual([child.id]);
  });

  it("groups files of a folder the map does not show, and loose files under their district", () => {
    const files = [at("project", "projects/unlisted/brainstorm.md"), at("project", "projects/unlisted/references.md"), at("knowledge", "knowledge/pricing.md")];
    const groups = atlasTodayGroups(files, files);
    expect(groups.map((g) => [g.key, g.title, g.rows.length])).toEqual([
      ["dir:project:projects/unlisted/", "Unlisted", 2],
      ["district:knowledge", "Knowledge", 1],
    ]);
    expect(groups[0]!.node).toBeNull();
    expect(groups[0]!.stories).toBeNull();
  });

  it("prefers a frontmatter title over the file stem", () => {
    const doc = at("knowledge", "knowledge/references.md", { title: "Sources for the market sizing" });
    expect(atlasTodayGroups([doc], [doc])[0]!.rows[0]!.title).toBe("Sources for the market sizing");
  });
});

describe("Today panel titles and kinds", () => {
  it("sentence-cases stems and keeps acronyms", () => {
    expect(atlasHumanTitle("projects/x/opportunity-sizing.md")).toBe("Opportunity sizing");
    expect(atlasHumanTitle("hq-landscape.md")).toBe("HQ landscape");
    expect(atlasHumanTitle("gtm_plan_v2.md")).toBe("GTM plan v2");
    expect(atlasHumanTitle("README.md")).toBe("README");
    expect(atlasHumanTitle("ship-iOS-build")).toBe("Ship iOS build");
  });

  it("tells PRDs, brainstorms, policies, meeting notes, source files and docs apart", () => {
    const k = (type: AtlasNode["type"], path: string) => atlasTodayKind({ type, path, folder: path.endsWith("/") });
    expect(k("project", "projects/a/prd.json")).toBe("prd");
    expect(k("project", "projects/a/brainstorm.md")).toBe("brainstorm");
    expect(k("policy", "policies/tenancy.md")).toBe("policy");
    expect(k("knowledge", "knowledge/meetings/2026-09-30-standup.md")).toBe("meeting");
    expect(k("repo", "repos/private/app/src/main.ts")).toBe("source");
    expect(k("knowledge", "knowledge/pricing.md")).toBe("knowledge");
    expect(k("project", "projects/a/references.md")).toBe("knowledge");
    expect(k("project", "projects/a/")).toBe("project");
    expect(k("repo", "repos/private/app/")).toBe("repo");
  });
});
