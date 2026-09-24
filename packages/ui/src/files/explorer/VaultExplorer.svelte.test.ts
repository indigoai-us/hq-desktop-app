// @vitest-environment happy-dom

// The Files explorer, mounted against a fake local HQ folder. Contract:
// - vaults are Personal plus companies the person can read;
// - settings folders and credential files never show in the tree;
// - a company vault binds the desktop read scope before anything is read;
// - a note renders its properties, [[links]] open the linked note, and the
//   rail lists the notes that link back;
// - Cmd+O opens the quick switcher.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { PlatformAdapter, VaultIndexWire } from "@hq/platform";
import type { Workspace } from "../../chat/workspaces.js";
import VaultExplorer from "./VaultExplorer.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const ok = <T,>(value: T) => ({ ok: true as const, value });

const DIRS: Record<string, Array<{ name: string; path: string; isDir: boolean; hasChildren: boolean }>> = {
  "companies/acme": [
    { name: "knowledge", path: "companies/acme/knowledge", isDir: true, hasChildren: true },
    { name: "settings", path: "companies/acme/settings", isDir: true, hasChildren: true },
    { name: "stripe-credentials.json", path: "companies/acme/stripe-credentials.json", isDir: false, hasChildren: false },
    { name: "README.md", path: "companies/acme/README.md", isDir: false, hasChildren: false },
  ],
  "companies/acme/knowledge": [
    { name: "pricing.md", path: "companies/acme/knowledge/pricing.md", isDir: false, hasChildren: false },
    { name: "tone.md", path: "companies/acme/knowledge/tone.md", isDir: false, hasChildren: false },
  ],
};

const FILES: Record<string, string> = {
  "companies/acme/knowledge/pricing.md":
    "---\nowner: Sara\ntags: [gtm, pricing]\n---\n# Pricing\n\nTone lives in [[tone]].\n\n## Tiers\n\nThree tiers.",
  "companies/acme/knowledge/tone.md": "# Tone\n\nPlain and warm.",
  "companies/acme/README.md": "# Acme\n\nStart with [[knowledge/pricing|pricing]].",
};

const INDEX: VaultIndexWire = {
  root: "companies/acme",
  truncated: false,
  files: [
    { path: "companies/acme/README.md", name: "README.md", isMarkdown: true, links: ["knowledge/pricing"] },
    { path: "companies/acme/knowledge/pricing.md", name: "pricing.md", isMarkdown: true, links: ["tone"] },
    { path: "companies/acme/knowledge/tone.md", name: "tone.md", isMarkdown: true, links: [] },
  ],
};

function makeAdapter(calls: string[]) {
  return {
    kind: "tauri",
    capabilities: {},
    isAvailable: () => false,
    appShell: {
      setActiveCompany: vi.fn(async (slug: string) => {
        calls.push(`scope:${slug}`);
        return ok(undefined);
      }),
    },
    shell: {},
    files: {
      listDir: vi.fn(async (p: string) => {
        calls.push(`list:${p}`);
        return ok(DIRS[p] ?? []);
      }),
      getFileContent: vi.fn(async (p: string) => {
        calls.push(`read:${p}`);
        return ok(FILES[p] ?? "");
      }),
      indexVault: vi.fn(async (root: string) => {
        calls.push(`index:${root}`);
        return ok(root === "companies/acme" ? INDEX : { root, truncated: false, files: [] });
      }),
      revealInFinder: vi.fn(async () => ok(undefined)),
    },
  } as unknown as PlatformAdapter;
}

const companies = [
  {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_1",
    bucketName: null,
    hasLocalFolder: true,
    localPath: "/hq/companies/acme",
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
  },
] as Workspace[];

async function settle(times = 6) {
  for (let i = 0; i < times; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

async function render(props: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const adapter = makeAdapter(calls);
  const onlocationchange = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(VaultExplorer, {
    target: host,
    props: { adapter, companies, vaultId: "company:acme", onlocationchange, ...props } as never,
  });
  await settle();
  return { host, calls, adapter, onlocationchange };
}

const rowNames = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-testid="vault-tree-row"]')].map((r) => r.textContent?.trim());

describe("VaultExplorer", () => {
  it("binds the company read scope before listing or indexing the vault", async () => {
    const { calls } = await render();
    const scopeAt = calls.indexOf("scope:acme");
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("list:companies/acme")).toBeGreaterThan(scopeAt);
    expect(calls.indexOf("index:companies/acme")).toBeGreaterThan(scopeAt);
  });

  it("never shows settings folders or credential files", async () => {
    const { host } = await render();
    expect(rowNames(host)).toEqual(["knowledge", "README"]);
  });

  it("lands on the vault home with counts", async () => {
    const { host } = await render();
    const home = host.querySelector('[data-testid="vault-home"]')!;
    expect(home.textContent).toContain("Acme");
    expect(home.textContent).toContain("3notes");
  });

  it("renders a note, follows a [[link]], and lists backlinks", async () => {
    const { host, onlocationchange } = await render();
    host.querySelector<HTMLButtonElement>('[data-tree-path="companies/acme/knowledge"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-tree-path="companies/acme/knowledge/pricing.md"]')!.click();
    await settle();

    const props = host.querySelector('[data-testid="note-properties"]')!;
    expect(props.textContent).toContain("Sara");
    expect(props.textContent).toContain("#gtm");
    expect(host.querySelector(".note-title")?.textContent).toBe("Pricing");
    expect(host.querySelector('[data-testid="vault-backlinks"]')!.textContent).toContain("README");
    expect(onlocationchange).toHaveBeenLastCalledWith({
      vaultId: "company:acme",
      path: "companies/acme/knowledge/pricing.md",
    });

    const link = host.querySelector<HTMLElement>('[data-testid="note-body"] .markdown-wikilink')!;
    expect(link.dataset.resolved).toBe("true");
    link.click();
    await settle();
    expect(host.querySelector(".note-title")?.textContent).toBe("Tone");
  });

  it("opens the quick switcher on Cmd+O and jumps to a file", async () => {
    const { host } = await render();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", metaKey: true }));
    await settle();
    const input = host.querySelector<HTMLInputElement>('[data-testid="quick-switcher"] input')!;
    input.value = "tone";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(host.querySelector('[data-testid="quick-switcher"]')).toBeNull();
    expect(host.querySelector(".note-title")?.textContent).toBe("Tone");
  });

  it("offers Personal and each readable company as vaults", async () => {
    const { host } = await render();
    host.querySelector<HTMLButtonElement>('[data-testid="vault-switcher"]')!.click();
    await settle();
    const items = [...host.querySelectorAll('[role="menuitemradio"]')].map((i) => i.textContent?.replace(/\s+/g, " ").trim());
    expect(items).toEqual(["P Personal Just you", "A Acme Company"]);
  });
});
