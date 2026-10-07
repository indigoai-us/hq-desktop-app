import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOP_FOLDERS,
  TREE_PAGE_LIMIT,
  TREE_PAGING_DISABLED,
  TREE_TOO_LARGE,
  grantSections,
  grantsFromTree,
  groupGrantSummaries,
  groupsFromBody,
  readCompanyGrants,
  readFolderGrants,
  topFolderOf,
  topFoldersFromListing,
  type ReadTree,
} from "./company-access.js";
import { filterGrants } from "./company-settings.js";

// Shapes follow hq-pro handleGroupList (GET /secrets/{co}/groups) and
// handleAclTree (GET /files/{co}/acl/tree): { prefix, direct, inherited,
// children, directRow, effectivePermission, identities, nextCursor? }.
const groupsBody = {
  groups: [
    { itemType: "GROUP", pk: "GROUP#cmp_x#grp_ops", groupId: "grp_ops", companyUid: "cmp_x", name: "Ops", creatorUid: "prs_a", createdAt: "2026-05-01" },
    { itemType: "GROUP", pk: "GROUP#cmp_x#grp_bot", groupId: "grp_bot", companyUid: "cmp_x", name: "Scout agent", description: "Single-agent ACL group", creatorUid: "prs_a", memberCount: 1 },
    { groupId: "", name: "broken" },
  ],
};

const entry = (granteeType: string, granteeId: string, permission: string, extra: Record<string, unknown> = {}) => ({
  granteeType,
  granteeId,
  permission,
  grantedBy: "prs_a",
  grantedAt: "2026-05-01T00:00:00.000Z",
  ...extra,
});

const agentsTree = {
  prefix: "agents/*",
  direct: [entry("group", "grp_ops", "admin")],
  inherited: [entry("person", "prs_a", "write", { sourcePrefix: "*" })],
  children: [
    entry("person", "agt_scout", "read", { sourcePrefix: "agents/scout/*" }),
    entry("email", "guest@example.com", "read", { sourcePrefix: "agents/scout/*" }),
    entry("email", "agt-9x@agents.example.com", "read", { sourcePrefix: "agents/scout/*" }),
    entry("company-wide", "", "read", { sourcePrefix: "agents/shared/*" }),
    entry("group", "grp_gone", "read", { sourcePrefix: "agents/shared/*" }),
  ],
  directRow: { creatorUid: "prs_b", open: false, createdAt: "x", updatedAt: "x" },
  effectivePermission: "admin",
  identities: {
    prs_a: { uid: "prs_a", type: "person", name: "Ana", email: "ana@example.com" },
    prs_b: { uid: "prs_b", type: "person", name: "Bo" },
    agt_scout: { uid: "agt_scout", type: "agent", name: "Scout" },
  },
};

const names = new Map([["grp_ops", "Ops"]]);

describe("groupsFromBody", () => {
  it("maps id, name, description and member count, sorted by name", () => {
    const groups = groupsFromBody(groupsBody);
    expect(groups.map((g) => g.id)).toEqual(["grp_ops", "grp_bot"]);
    expect(groups[0]).toMatchObject({ name: "Ops", description: "", memberCount: null });
    expect(groups[1]).toMatchObject({ name: "Scout agent", description: "Single-agent ACL group", memberCount: 1 });
  });

  it("throws on a body without a groups list so the pane shows failed, not zero", () => {
    expect(() => groupsFromBody({ error: "nope" })).toThrow();
    expect(() => groupsFromBody(null)).toThrow();
  });
});

describe("grantsFromTree", () => {
  const rows = grantsFromTree(agentsTree, { groupNames: names, now: Date.parse("2026-10-01T00:00:00Z") });
  const by = (id: string) => rows.find((r) => r.id === id);

  it("maps every grantee type to a kind and keeps the source folder", () => {
    expect(by("agents/*|group|grp_ops")).toMatchObject({ kind: "group", principal: "Ops", level: "admin", granteeId: "grp_ops" });
    expect(by("*|person|prs_a")).toMatchObject({ kind: "person", principal: "Ana", detail: "ana@example.com", level: "write" });
    expect(by("agents/scout/*|person|agt_scout")).toMatchObject({ kind: "agent", principal: "Scout" });
    expect(by("agents/scout/*|email|guest@example.com")).toMatchObject({ kind: "guest", principal: "guest@example.com" });
    expect(by("agents/scout/*|email|agt-9x@agents.example.com")).toMatchObject({ kind: "agent" });
    expect(by("agents/shared/*|company-wide|")).toMatchObject({ kind: "group", principal: "Everyone in the company" });
    expect(by("agents/shared/*|group|grp_gone")).toMatchObject({ principal: "grp_gone" });
  });

  it("lists the folder creator as admin", () => {
    expect(by("agents/*|creator|prs_b")).toMatchObject({ kind: "person", principal: "Bo", level: "admin", detail: "Created this folder" });
  });

  it("marks grants with an expiry inside 7 days as expiring", () => {
    const tree = { prefix: "x/*", direct: [entry("person", "prs_a", "read", { expiresAt: "2026-10-04T00:00:00Z" }), entry("person", "prs_b", "read", { expiresAt: "2026-12-01T00:00:00Z" })], identities: {} };
    const out = grantsFromTree(tree, { groupNames: names, now: Date.parse("2026-10-01T00:00:00Z") });
    expect(out.map((r) => r.expiring)).toEqual([true, false]);
    expect(filterGrants(out, "expiring")).toHaveLength(1);
    expect(rows.every((r) => r.expiry === "No expiry")).toBe(true);
  });

  it("throws on a body that is not a tree", () => {
    expect(() => grantsFromTree("nope", { groupNames: names })).toThrow();
  });
});

describe("readFolderGrants paging", () => {
  const ctx = { groupNames: names };

  it("reads a folder whole when it fits", async () => {
    const readTree = vi.fn<ReadTree>(async () => ({ ok: true, value: agentsTree }));
    const { rows, read } = await readFolderGrants(readTree, "cmp_x", "agents", ctx);
    expect(readTree).toHaveBeenCalledTimes(1);
    expect(readTree).toHaveBeenCalledWith("cmp_x", "agents/*");
    expect(read.status).toBe("ok");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("pages an over-budget folder with limit and cursor until nextCursor is null", async () => {
    const page = (n: number, next: string | null) => ({
      prefix: "sources/*",
      direct: [],
      inherited: [],
      children: [entry("person", `prs_${n}`, "read", { sourcePrefix: `sources/${n}/*` })],
      identities: {},
      nextCursor: next,
    });
    const readTree = vi.fn<ReadTree>(async (_uid, _prefix, p) => {
      if (!p) return { ok: false, reason: "error", code: TREE_TOO_LARGE, message: "too big" };
      if (!p.cursor) return { ok: true, value: page(1, "MjAw") };
      if (p.cursor === "MjAw") return { ok: true, value: page(2, "NDAw") };
      return { ok: true, value: page(3, null) };
    });
    const { rows, read } = await readFolderGrants(readTree, "cmp_x", "sources", ctx);
    expect(read.status).toBe("ok");
    expect(rows.map((r) => r.path)).toEqual(["sources/1/*", "sources/2/*", "sources/3/*"]);
    expect(readTree.mock.calls.map((c) => c[2])).toEqual([
      undefined,
      { limit: TREE_PAGE_LIMIT },
      { limit: TREE_PAGE_LIMIT, cursor: "MjAw" },
      { limit: TREE_PAGE_LIMIT, cursor: "NDAw" },
    ]);
  });

  it("reports too-large when the server has paging off", async () => {
    const readTree = vi.fn<ReadTree>(async (_u, _p, page) =>
      page
        ? { ok: false, reason: "error", code: TREE_PAGING_DISABLED, message: "off" }
        : { ok: false, reason: "error", code: TREE_TOO_LARGE, message: "too big" },
    );
    const { rows, read } = await readFolderGrants(readTree, "cmp_x", "signals", ctx);
    expect(rows).toEqual([]);
    expect(read).toMatchObject({ folder: "signals", status: "too-large" });
  });

  it("reports failed, never an empty ok, when a read errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readTree = vi.fn<ReadTree>(async () => ({ ok: false, reason: "error", code: "http-500", message: "boom" }));
    const { read } = await readFolderGrants(readTree, "cmp_x", "agents", ctx);
    expect(read.status).toBe("failed");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("readCompanyGrants", () => {
  it("reads every folder, merges whole-vault grants once, and reports progress", async () => {
    const knowledge = { prefix: "knowledge/*", direct: [entry("group", "grp_ops", "read")], inherited: [entry("person", "prs_a", "write", { sourcePrefix: "*" })], children: [], identities: agentsTree.identities };
    const readTree = vi.fn<ReadTree>(async (_u, prefix) => ({ ok: true, value: prefix === "agents/*" ? agentsTree : knowledge }));
    const progress: Array<[number, number]> = [];
    const read = await readCompanyGrants({ readTree, companyUid: "cmp_x", folders: ["agents", "knowledge", "agents"], ctx: { groupNames: names }, onProgress: (d, t) => progress.push([d, t]) });
    expect(readTree).toHaveBeenCalledTimes(2);
    expect(read.grants.filter((g) => g.id === "*|person|prs_a")).toHaveLength(1);
    expect(read.folders.map((f) => f.status)).toEqual(["ok", "ok"]);
    expect(progress.at(-1)).toEqual([2, 2]);

    const sections = grantSections(read.grants);
    expect(sections[0]!.folder).toBe("*");
    const agents = sections.find((s) => s.folder === "agents")!;
    expect(agents.counts).toEqual({ person: 1, group: 3, agent: 2, guest: 1 });

    const ops = groupGrantSummaries(read.grants).get("grp_ops")!;
    expect(ops).toEqual({ total: 2, byLevel: { read: 1, write: 0, admin: 1 }, folders: ["agents", "knowledge"] });
  });
});

describe("top folders", () => {
  it("takes directories from the company folder listing and skips dot folders", () => {
    expect(topFoldersFromListing([
      { name: "projects", path: "companies/x/projects", isDir: true, hasChildren: true },
      { name: ".obsidian", path: "companies/x/.obsidian", isDir: true, hasChildren: true },
      { name: "README.md", path: "companies/x/README.md", isDir: false, hasChildren: false },
      { name: "agents", path: "companies/x/agents", isDir: true, hasChildren: false },
    ])).toEqual(["agents", "projects"]);
    expect(topFoldersFromListing(null)).toEqual([]);
    expect(DEFAULT_TOP_FOLDERS).toContain("knowledge");
  });

  it("files a path under its first segment, the vault root under whole company", () => {
    expect(topFolderOf("agents/scout/*")).toBe("agents");
    expect(topFolderOf("*")).toBe("*");
    expect(topFolderOf("")).toBe("*");
  });
});
