import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeAtlasGraph, type AtlasPresence } from "./atlas-model.js";
import { atlasHoverActivity, atlasHoverContent, atlasNamesLine } from "./atlas-hover.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const graph = smokeAtlasGraph();
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const ctx = (presence: AtlasPresence[] = []) => ({ byId, edges: graph.edges ?? [], presence, nowMs: NOW });
const RAIL = "project:projects/hq-desktop-console-rail/";

describe("Atlas hover card content", () => {
  it("fills every row a project has data for", () => {
    const presence: AtlasPresence[] = Array.from({ length: 7 }, (_, i) => ({
      nodeId: RAIL,
      actorUid: `u_${i}`,
      name: `Person ${i}`,
      bot: i === 6,
      ...(i === 0 ? { avatarUrl: "data:image/png;base64,P0" } : {}),
    }));
    const c = atlasHoverContent(byId.get(RAIL)!, ctx(presence));
    expect(c.kind).toBe("Project");
    expect(c.title).toBe("hq desktop console rail");
    expect(c.people?.label).toBe("On it now");
    expect(c.people?.shown).toHaveLength(5);
    expect(c.people?.shown[0]?.avatarUrl).toBe("data:image/png;base64,P0");
    expect(c.people?.more).toBe(2);
    expect(c.stories).toEqual({ done: 0, total: 9, fraction: 0, text: "0 of 9 stories done" });
    expect(c.links).toEqual([{ label: "Repos", text: "hq desktop app" }]);
    expect(c.counts).toBe("1 knowledge doc · 1 worker");
    expect(c.activity).toBe("Born Jul 16 · Touched 12 h ago · 14 inside");
    expect(c.hint).toBe("Click to focus");
  });

  it("gives a bare project only its header and activity", () => {
    const c = atlasHoverContent(byId.get("project:projects/launch-landing/")!, ctx());
    expect(c).toEqual({
      kind: "Project",
      title: "launch landing",
      links: [],
      activity: "Born Aug 1 · Touched Sep 29 · 6 inside",
      hint: "Click to focus",
    });
  });

  it("shows a repo's projects, a file's folder and referencing projects, and a worker's projects", () => {
    const repo = atlasHoverContent(byId.get("repo:repos/private/hq-desktop-app/")!, ctx([{ nodeId: "repo:repos/private/hq-desktop-app/", actorUid: "b_1", name: "scout", bot: true }]));
    expect(repo.kind).toBe("Repo");
    expect(repo.links).toEqual([{ label: "Projects", text: "hq desktop console rail" }]);
    expect(repo.people?.shown.map((p) => p.name)).toEqual(["scout"]);
    const doc = atlasHoverContent(byId.get("knowledge:knowledge/design-styles.md")!, ctx());
    expect(doc.folder).toBe("knowledge/");
    expect(doc.links).toEqual([{ label: "Projects", text: "hq desktop console rail" }]);
    const policy = atlasHoverContent(byId.get("policy:policies/tenancy.md")!, ctx());
    expect(policy.kind).toBe("Policy");
    expect(policy.links).toEqual([]);
    const worker = atlasHoverContent(byId.get("worker:workers/paper-designer/")!, ctx());
    expect(worker.links).toEqual([{ label: "Projects", text: "hq desktop console rail" }]);
  });

  it("caps names with a count and writes recent times relatively", () => {
    expect(atlasNamesLine(["a", "b", "c", "d", "e"])).toBe("a, b, c +2");
    expect(atlasNamesLine(["a", "b"])).toBe("a, b");
    expect(atlasHoverActivity({ touched: NOW - 2 * 3_600_000, count: 0, folder: false }, NOW)).toBe("Touched 2 h ago");
    expect(atlasHoverActivity({ count: 0, folder: false }, NOW)).toBe("");
  });

  it("cuts long names and rows with an ellipsis instead of wrapping", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "AtlasMap.svelte"), "utf8");
    for (const rule of [".hc-title", ".hc-text"]) {
      const body = css.slice(css.indexOf(`  ${rule} {`), css.indexOf("}", css.indexOf(`  ${rule} {`)));
      expect(body, rule).toContain("text-overflow: ellipsis");
      expect(body, rule).toContain("white-space: nowrap");
    }
  });
});
