// @vitest-environment happy-dom
/**
 * OWNER-R13 and OWNER-R17: the company Vault page is built from the Files
 * page's explorer (tree, viewer, folder view, right pane), and the right
 * pane leads with Access, then Outline, then Linked here, each foldable.
 * Placeholders stand in for real company paths and people.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, unavailable, type SettingsApi, type ShellApi } from "@hq/platform";
import FilesConnectPage from "./FilesConnectPage.svelte";
import VaultExplorer from "../../files/explorer/VaultExplorer.svelte";

vi.mock("../company-store.svelte.js", () => ({
  companyStore: { revision: 0, loadSecrets: vi.fn(async () => []), loadDeployments: vi.fn(async () => []) },
}));

const ROOT = "companies/acme";
const tree: Record<string, unknown[]> = {
  [ROOT]: [
    { name: "knowledge", path: `${ROOT}/knowledge`, isDir: true, hasChildren: true },
    { name: "a-very-long-file-name-that-would-push-the-tree-sideways-in-the-old-vault-page.md", path: `${ROOT}/a-very-long-file-name-that-would-push-the-tree-sideways-in-the-old-vault-page.md`, isDir: false, hasChildren: false },
  ],
  [`${ROOT}/knowledge`]: [{ name: "plan.md", path: `${ROOT}/knowledge/plan.md`, isDir: false, hasChildren: false }],
};

const flush = async () => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};

let component: Record<string, unknown> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

function mountVault(extra: Record<string, unknown> = {}, files: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(FilesConnectPage, {
    target,
    props: {
      page: "vault",
      slug: "acme",
      companyLabel: "Acme",
      companyUid: "cmp_acme",
      files: {
        listDir: vi.fn(async (p: string) => ok(tree[p] ?? [])),
        getFileContent: vi.fn(async (p: string) => (p.endsWith("plan.md") ? ok("# Plan\n\n## Goals\n\nShip.") : unavailable("not on this Mac"))),
        ...files,
      },
      shell: { openFileInClaude: vi.fn(async () => ok(undefined)) } as unknown as ShellApi,
      settings: { getConfig: vi.fn(async () => ok({})) } as unknown as SettingsApi,
      openExternal: vi.fn(),
      ...extra,
    } as never,
  });
  flushSync();
  return target;
}

describe("OWNER-R13 Vault built from the Files components", () => {
  it("no second tree, viewer or breadcrumb in the Vault code", () => {
    const src = readFileSync(join(process.cwd(), "src/company/files-connect/FilesConnectPage.svelte"), "utf8");
    expect(src).toContain("VaultExplorer");
    expect(src).not.toMatch(/CompanyFileTree|FilePreviewPane|vault-preview|vault-root|Select a file/);
  });

  it("the tree never scrolls sideways: long names truncate with the full name on hover", async () => {
    const css = readFileSync(join(process.cwd(), "src/files/explorer/VaultTree.svelte"), "utf8");
    expect(css).toMatch(/\.vt \{[^}]*overflow-x: hidden;/);
    expect(css).toMatch(/\.vt-name \{[^}]*text-overflow: ellipsis;/);
    for (const [w, h] of [[1000, 700], [1440, 900]] as const) {
      Object.assign(window, { innerWidth: w, innerHeight: h });
      const el = mountVault();
      await flush();
      const row = el.querySelector<HTMLElement>(`[data-tree-path='${ROOT}/a-very-long-file-name-that-would-push-the-tree-sideways-in-the-old-vault-page.md']`)!;
      expect(row.title).toBe("a-very-long-file-name-that-would-push-the-tree-sideways-in-the-old-vault-page.md");
      await unmount(component!);
      component = null;
      document.body.innerHTML = "";
    }
  });

  it("a cloud-only file opens through the vault read, with no Show in Finder", async () => {
    const vaultCloudRead = vi.fn(async (key: string) => (key === "knowledge/remote.md" ? "# Remote\n\nOnly in the cloud." : null));
    const adapter = {
      files: {
        listDir: vi.fn(async (p: string) => ok(tree[p] ?? [])),
        getFileContent: vi.fn(async () => unavailable("not on this Mac")),
        atlasLocal: { listing: vi.fn(async () => ok({ objects: [{ key: "knowledge/remote.md", lastModified: new Date().toISOString() }] })), firstPage: vi.fn(), readText: vi.fn() },
        revealInFinder: vi.fn(async () => ok(undefined)),
      },
      appShell: { setActiveCompany: vi.fn(async () => ok(undefined)) },
      shell: {},
      isAvailable: (cap: string) => cap === "localFiles",
    };
    const el = mountVault({ adapter, vaultCloudRead, files: adapter.files });
    await flush();
    (el.querySelector("[data-testid='vault-whats-new']") as HTMLButtonElement).click();
    await flush();
    (el.querySelector("[data-testid='vault-recent-row']") as HTMLButtonElement).click();
    await flush();
    expect(vaultCloudRead).toHaveBeenCalledWith("knowledge/remote.md");
    expect(el.querySelector("[data-testid='vault-content']")?.textContent).toContain("Only in the cloud.");
    expect([...el.querySelectorAll("button")].some((b) => /Show in /.test(b.textContent ?? ""))).toBe(false);
  });
});

describe("OWNER-R17 right pane on the Files page", () => {
  it("Access leads, then Outline, then Linked here; folding is remembered", async () => {
    const files = {
      listDir: vi.fn(async (p: string) => ok(tree[p] ?? [])),
      getFileContent: vi.fn(async () => ok("# Plan\n\n## Goals\n\nShip.")),
      revealInFinder: vi.fn(async () => ok(undefined)),
    };
    const readTree = vi.fn(async () => ok({ prefix: "knowledge/plan.md", direct: [], inherited: [], children: [], directRow: null, effectivePermission: "read", identities: {} }));
    const adapter = { files, appShell: { setActiveCompany: vi.fn(async () => ok(undefined)) }, shell: {}, isAvailable: () => false };
    const companies = [{ slug: "acme", displayName: "Acme", kind: "company", state: "synced", cloudUid: "cmp_acme", hasLocalFolder: true, membershipStatus: "active", role: "member" }];
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(VaultExplorer, {
      target,
      props: { adapter: adapter as never, companies: companies as never, vaultId: "company:acme", path: `${ROOT}/knowledge/plan.md`, access: { companyUidFor: () => "cmp_acme", readTree } },
    });
    await flush();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='access-section']")).not.toBeNull());
    const titles = [...target.querySelectorAll("[data-testid='vault-rail'] h3")].map((h) => h.textContent?.replace(/\s+\d+$/, "").trim());
    expect(titles).toEqual(["Access", "Outline", "Linked here"]);
    (target.querySelector("[data-testid='vault-access'] .fold") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='access-section']")).toBeNull();
    expect(JSON.parse(localStorage.getItem("hq.files.rail.collapsed") ?? "{}").access).toBe(true);
  });
});
