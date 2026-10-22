// @vitest-environment happy-dom
/**
 * OWNER-R17: the right pane's Access section. Fixtures follow the hq-pro
 * GET /files/{companyUid}/acl/tree body (prefix, direct, inherited, children,
 * directRow, effectivePermission, identities) and GET /secrets/{uid}/groups,
 * with placeholder people and ids.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, unavailable } from "@hq/platform";
import AccessSection from "./AccessSection.svelte";
import AccessSectionHarness from "./AccessSectionHarness.test-support.svelte";
import { accessCache, accessPrefix, accessView } from "./access-model.js";
import type { Vault } from "./vault-model.js";

const COMPANY: Vault = { id: "company:acme", kind: "company", label: "Acme", root: "companies/acme", slug: "acme" };
const PERSONAL: Vault = { id: "personal", kind: "personal", label: "Personal", root: "", slug: null };

const identities = {
  prs_AAAAAAAA: { uid: "prs_AAAAAAAA", type: "person", name: "Person A", email: "a@example.com" },
  prs_BBBBBBBB: { uid: "prs_BBBBBBBB", type: "person", name: "Person B", email: "b@example.com" },
  agt_CCCCCCCC: { uid: "agt_CCCCCCCC", type: "agent", name: "Report Bot" },
};

const FILE_TREE = {
  prefix: "knowledge/plan.md",
  direct: [{ granteeType: "person", granteeId: "prs_AAAAAAAA", permission: "write", grantedBy: "prs_BBBBBBBB", grantedAt: "2026-09-01T00:00:00Z" }],
  inherited: [
    { granteeType: "group", granteeId: "grp_core", permission: "read", grantedBy: "prs_BBBBBBBB", grantedAt: "2026-08-01T00:00:00Z", sourcePrefix: "knowledge/*" },
    { granteeType: "person", granteeId: "agt_CCCCCCCC", permission: "read", grantedBy: "prs_BBBBBBBB", grantedAt: "2026-08-01T00:00:00Z", sourcePrefix: "*" },
  ],
  children: [],
  directRow: { creatorUid: "prs_BBBBBBBB", open: false, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
  effectivePermission: "read",
  identities,
};

const FOLDER_TREE = {
  prefix: "projects/",
  direct: [{ granteeType: "company-wide", granteeId: "", permission: "read", grantedBy: "prs_BBBBBBBB", grantedAt: "2026-09-01T00:00:00Z" }],
  inherited: [],
  children: [],
  directRow: null,
  effectivePermission: "admin",
  identities,
};

const GROUPS = { groups: [{ itemType: "GROUP", groupId: "grp_core", name: "core", companyUid: "cmp_acme" }] };

let component: Record<string, unknown> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(AccessSection, { target, props: { debounceMs: 0, ...props } as never });
  flushSync();
  return target;
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};

let n = 0;
const uniquePath = (base: string) => `${base}-${(n += 1)}`;

describe("OWNER-R17 access model", () => {
  it("reasons in the console's words, people by name, never an id", () => {
    const view = accessView(FILE_TREE, new Map([["grp_core", "core"]]));
    const byKey = Object.fromEntries(view.rows.map((r) => [r.key, r]));
    expect(byKey.owner!.reason).toBe("Owner of this company");
    expect(byKey["person:prs_AAAAAAAA"]!.reason).toBe("granted directly");
    expect(byKey["person:prs_AAAAAAAA"]!.levelLabel).toBe("Read and write");
    expect(byKey["group:grp_core"]!.reason).toBe("via group core");
    expect(byKey["person:prs_BBBBBBBB"]!.reason).toBe("they created it");
    expect(byKey["person:agt_CCCCCCCC"]!.name).toBe("Report Bot");
    expect(byKey["person:agt_CCCCCCCC"]!.detail).toBe("Bot");
    expect(view.inheritedFrom).toBe("knowledge");
    expect(view.canGrant).toBe(false);
    expect(JSON.stringify(view.rows.map((r) => [r.name, r.detail]))).not.toMatch(/prs_|agt_|grp_/);
  });

  it("company-wide grants read as shared company-wide; admin can grant", () => {
    const view = accessView(FOLDER_TREE);
    expect(view.rows.find((r) => r.key === "company")!.reason).toBe("shared company-wide");
    expect(view.canGrant).toBe(true);
  });
});

describe("OWNER-R17 AccessSection", () => {
  it("file: rows with names, levels and reasons; inherited folder focuses on click; read-only has no Grant", async () => {
    const readTree = vi.fn(async () => ok(FILE_TREE));
    const onfocusfolder = vi.fn();
    const ongrant = vi.fn();
    const path = `companies/acme/knowledge/${uniquePath("plan")}.md`;
    const el = render({ vault: COMPANY, path, isDir: false, companyUid: "cmp_acme", readTree, readGroups: async () => ok(GROUPS), onfocusfolder, ongrant });
    expect(el.querySelector("[data-testid='access-rows']")).toBeNull();
    await settle();
    const rows = [...el.querySelectorAll("[data-testid='access-row']")].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toContain("Company owners Admin Owner of this company");
    expect(rows).toContain("Person A a@example.com Read and write granted directly");
    expect(rows).toContain("Group core Read via group core");
    expect(el.textContent).not.toMatch(/prs_|agt_|grp_/);
    expect(readTree).toHaveBeenCalledWith("cmp_acme", path.replace("companies/acme/", ""));
    (el.querySelector("[data-testid='access-inherited-link']") as HTMLButtonElement).click();
    expect(onfocusfolder).toHaveBeenCalledWith("companies/acme/knowledge");
    // Read-only viewer: no dead Grant control.
    expect(el.querySelector("[data-testid='access-grant']")).toBeNull();
  });

  it("folder: asks for the folder prefix; an admin sees Grant, which hands off for its confirm", async () => {
    const readTree = vi.fn(async () => ok(FOLDER_TREE));
    const ongrant = vi.fn();
    const path = `companies/acme/${uniquePath("projects")}`;
    const el = render({ vault: COMPANY, path, isDir: true, companyUid: "cmp_acme", readTree, ongrant });
    await settle();
    expect(readTree).toHaveBeenCalledWith("cmp_acme", `${path.replace("companies/acme/", "")}/*`);
    (el.querySelector("[data-testid='access-grant']") as HTMLButtonElement).click();
    expect(ongrant).toHaveBeenCalledWith(path, true);
  });

  it("feedback 227937a0: a folder asks for its canonical glob, so its own row is direct, not inherited from itself", async () => {
    // hq-pro stores folder grants at `<folder>/*` and acl/tree compares the
    // asked prefix as-is. Asking for `projects/` put the folder's own row in
    // `inherited` (sourcePrefix `projects/*`) and the panel said the folder
    // inherits access from itself.
    expect(accessPrefix(COMPANY, "companies/acme/projects", true)).toBe("projects/*");
    expect(accessPrefix(COMPANY, "companies/acme/projects/", true)).toBe("projects/*");
    expect(accessPrefix(COMPANY, "companies/acme/projects/launch-tasks", true)).toBe("projects/launch-tasks/*");
    expect(accessPrefix(COMPANY, "companies/acme/projects/plan.md", false)).toBe("projects/plan.md");
    expect(accessPrefix(PERSONAL, "knowledge", true)).toBe("knowledge/*");

    const OWN_ROW_TREE = {
      prefix: "projects/*",
      direct: [{ granteeType: "person", granteeId: "prs_AAAAAAAA", permission: "write", grantedBy: "prs_BBBBBBBB", grantedAt: "2026-09-01T00:00:00Z" }],
      inherited: [{ granteeType: "company-wide", granteeId: "", permission: "read", grantedBy: "prs_BBBBBBBB", grantedAt: "2026-08-01T00:00:00Z", sourcePrefix: "*" }],
      children: [],
      directRow: { creatorUid: "prs_BBBBBBBB", open: false, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      effectivePermission: "admin",
      identities,
    };
    const readTree = vi.fn(async (_uid: string, prefix: string) => (prefix === "projects/*" ? ok(OWN_ROW_TREE) : unavailable("unexpected-prefix")));
    const el = render({ vault: COMPANY, path: "companies/acme/projects", isDir: true, companyUid: "cmp_acme", readTree });
    await settle();
    expect(readTree).toHaveBeenCalledWith("cmp_acme", "projects/*");
    const rows = [...el.querySelectorAll("[data-testid='access-row']")].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toContain("Person A a@example.com Read and write granted directly");
    // Inherits from the vault root, never from the folder itself.
    expect(el.querySelector("[data-testid='access-inherited']")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Inherits access from Acme");
  });

  it("feedback 227937a0: a folder with no ACL rows shows default company access, not a failure", async () => {
    // `hq files acl projects/` says no ACL record exists; acl/tree answers 200
    // with empty sections. That is the owners-only default, not an error.
    const EMPTY_TREE = { prefix: "projects/*", direct: [], inherited: [], children: [], directRow: null, effectivePermission: "admin", identities: {}, masking: [], coveringAclPath: null };
    const readTree = vi.fn(async () => ok(EMPTY_TREE));
    const el = render({ vault: COMPANY, path: `companies/acme/${uniquePath("projects")}`, isDir: true, companyUid: "cmp_acme", readTree, ongrant: vi.fn() });
    await settle();
    expect(el.querySelector("[data-testid='access-failed']")).toBeNull();
    // With no row on or above the folder the panel states the default (PR 1760).
    expect(el.querySelector("[data-testid='access-no-record']")?.textContent?.trim()).toBe("Uses the company's default access");
    expect(el.querySelector("[data-testid='access-grant']")).not.toBeNull();
  });

  it("personal vault item that is not shared reads Only you", async () => {
    const readTree = vi.fn(async () => ok({ ...FOLDER_TREE, direct: [], effectivePermission: "admin" }));
    const el = render({ vault: PERSONAL, path: `personal/${uniquePath("notes")}.md`, isDir: false, companyUid: "prs_SELF0000", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-only-you']")?.textContent).toBe("Only you");
  });

  it("local only: one line and no read", async () => {
    const readTree = vi.fn(async () => ok(FILE_TREE));
    const el = render({ vault: PERSONAL, path: "workspace/reports/x.md", isDir: false, companyUid: "prs_SELF0000", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-local']")?.textContent).toBe("On this Mac only. Not synced or shared.");
    expect(readTree).not.toHaveBeenCalled();
    const el2 = render({ vault: COMPANY, path: "companies/acme/a.md", isDir: false, companyUid: null, readTree });
    await settle();
    expect(el2.querySelector("[data-testid='access-local']")).not.toBeNull();
  });

  it("failed read: its own failed state and Try again; never 'no one' before a good read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const readTree = vi.fn(async () => (fail ? unavailable("boom") : ok(FILE_TREE)));
    const el = render({ vault: COMPANY, path: `companies/acme/${uniquePath("f")}.md`, isDir: false, companyUid: "cmp_acme", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-failed']")?.textContent).toContain("Couldn't read who has access.");
    expect(el.textContent).not.toContain("boom");
    expect(el.querySelector("[data-testid='access-rows']")).toBeNull();
    fail = false;
    (el.querySelector("[data-testid='access-retry']") as HTMLButtonElement).click();
    await settle();
    expect(el.querySelectorAll("[data-testid='access-row']").length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  // feedback 227937a0: `hq files acl projects/` printed "No ACL record exists"
  // for these prefixes. That line is the CLI's own; it prints it when the
  // 200 tree body below has no row, no inherited and no child grants.
  const NO_RECORD_TREE = {
    prefix: "projects/",
    direct: [],
    inherited: [],
    children: [],
    directRow: null,
    effectivePermission: "admin",
    coveringAclPath: null,
    identities: {},
    masking: [],
  };

  it("feedback 227937a0: a folder with no ACL record says it inherits its folder's access, not an owners-only list", async () => {
    const readTree = vi.fn(async () => ok(NO_RECORD_TREE));
    const el = render({ vault: COMPANY, path: `${COMPANY.root}/${uniquePath("noacl")}`, isDir: true, companyUid: "cmp_acme", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-failed']")).toBeNull();
    expect(el.querySelector("[data-testid='access-no-record']")?.textContent).toBe("Uses the company's default access");
    expect(el.querySelectorAll("[data-testid='access-row']")).toHaveLength(0);
  });

  it("feedback 227937a0: a subfolder under a parent row with no grants links to that parent", async () => {
    const readTree = vi.fn(async () => ok({ ...NO_RECORD_TREE, prefix: "projects/launch-tasks/", coveringAclPath: "projects/" }));
    const el = render({ vault: COMPANY, path: `${COMPANY.root}/${uniquePath("noacl-sub")}`, isDir: true, companyUid: "cmp_acme", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-no-record']")).toBeNull();
    expect(el.querySelector("[data-testid='access-inherited-link']")?.textContent?.trim()).toBe("projects");
  });

  it("feedback 227937a0: a folder whose only covering row is its own lock row does not link to itself", async () => {
    const readTree = vi.fn(async () => ok({ ...NO_RECORD_TREE, prefix: "projects/", coveringAclPath: "projects/*" }));
    const el = render({ vault: COMPANY, path: `${COMPANY.root}/${uniquePath("noacl-self")}`, isDir: true, companyUid: "cmp_acme", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-inherited']")).toBeNull();
    expect(el.querySelector("[data-testid='access-no-record']")?.textContent).toBe("Uses the company's default access");
  });

  it("feedback 227937a0: personal vault path with no ACL record reads Only you", async () => {
    const readTree = vi.fn(async () => ok({ ...NO_RECORD_TREE, prefix: "notes/" }));
    const el = render({ vault: PERSONAL, path: `personal/${uniquePath("noacl")}.md`, isDir: false, companyUid: "prs_SELF0000", readTree });
    await settle();
    expect(el.querySelector("[data-testid='access-failed']")).toBeNull();
    expect(el.querySelector("[data-testid='access-only-you']")?.textContent).toBe("Only you");
  });

  it("debounces focus: arrowing through rows fires one read, for the last row; the cache paints at once", async () => {
    vi.useFakeTimers();
    const readTree = vi.fn(async () => ok(FILE_TREE));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const ctl: { setPath?: (p: string) => void } = {};
    const initial = { vault: COMPANY, path: "companies/acme/r1.md", isDir: false, companyUid: "cmp_acme", readTree, debounceMs: 250 };
    component = mount(AccessSectionHarness, { target, props: { initial, ctl } });
    flushSync();
    for (const p of ["companies/acme/r2.md", "companies/acme/r3.md", "companies/acme/r4.md"]) {
      ctl.setPath!(p);
      flushSync();
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(300);
    flushSync();
    expect(readTree).toHaveBeenCalledTimes(1);
    expect(readTree).toHaveBeenCalledWith("cmp_acme", "r4.md");
    expect(accessCache.get({ companyUid: "cmp_acme", prefix: "r4.md" })).not.toBeNull();
    ctl.setPath!("companies/acme/r1.md");
    flushSync();
    ctl.setPath!("companies/acme/r4.md");
    flushSync();
    // Cached: rows show before any new read resolves.
    expect(target.querySelectorAll("[data-testid='access-row']").length).toBeGreaterThan(0);
  });
});
