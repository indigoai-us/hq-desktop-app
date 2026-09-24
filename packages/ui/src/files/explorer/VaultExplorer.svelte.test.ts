// @vitest-environment happy-dom

// The Files explorer, mounted against a fake local HQ folder. Contract:
// - vaults are Personal plus companies the person can read;
// - settings folders and credential files never show in the tree;
// - a company vault binds the desktop read scope before anything is read;
// - a note renders its properties, [[links]] open the linked note, and the
//   rail lists the notes that link back;
// - Cmd+O opens the quick switcher;
// - whole-vault questions go to the native vault index, never a file list;
// - a note larger than the read cap says so and offers the whole file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { PlatformAdapter, VaultFileHit, VaultNoteLinks } from "@hq/platform";
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

const hit = (path: string): VaultFileHit => ({ path, name: path.split("/").pop()!, isMarkdown: path.endsWith(".md") });

// What the native index would answer for the Acme vault.
const RESOLVE: Record<string, string> = {
  tone: "companies/acme/knowledge/tone.md",
  "knowledge/pricing": "companies/acme/knowledge/pricing.md",
};
const BACKLINKS: Record<string, string[]> = {
  "companies/acme/knowledge/pricing.md": ["companies/acme/README.md"],
  "companies/acme/knowledge/tone.md": ["companies/acme/knowledge/pricing.md"],
};

const BIG_NOTE = "companies/acme/knowledge/big.md";

function makeAdapter(calls: string[]) {
  return {
    kind: "tauri",
    capabilities: {},
    isAvailable: (cap: string) => cap === "localFiles",
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
        calls.push(`whole:${p}`);
        return ok(FILES[p] ?? "");
      }),
      revealInFinder: vi.fn(async (p: string) => {
        calls.push(`reveal:${p}`);
        return ok(undefined);
      }),
      vault: {
        summary: vi.fn(async (root: string) => {
          calls.push(`summary:${root}`);
          return ok({
            root,
            notes: 3,
            files: 3,
            links: 2,
            truncated: false,
            hubs: [{ path: "companies/acme/knowledge/pricing.md", count: 1 }],
            folders: [{ name: "knowledge", files: 2 }],
          });
        }),
        search: vi.fn(async (root: string, _sys: boolean, query: string) => {
          calls.push(`search:${root}:${query}`);
          return ok(Object.keys(FILES).filter((p) => p.includes(query)).map(hit));
        }),
        noteLinks: vi.fn(async (root: string, _sys: boolean, path: string, targets: string[]) => {
          calls.push(`links:${root}:${path}`);
          const links: VaultNoteLinks = {
            resolved: targets.map((target) => ({ target, path: RESOLVE[target] ?? null })),
            backlinks: (BACKLINKS[path] ?? []).map(hit),
            backlinkCount: (BACKLINKS[path] ?? []).length,
            outgoing: targets.flatMap((t) => (RESOLVE[t] ? [hit(RESOLVE[t])] : [])),
          };
          return ok(links);
        }),
        readNote: vi.fn(async (p: string) => {
          calls.push(`read:${p}`);
          if (p === BIG_NOTE) return ok({ text: "# Big\n\nThe start.\n", size: 3 * 1024 * 1024, truncated: true });
          const text = FILES[p] ?? "";
          return ok({ text, size: text.length, truncated: false });
        }),
      },
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
  it("binds the company read scope before listing or asking the vault index", async () => {
    const { calls } = await render();
    const scopeAt = calls.indexOf("scope:acme");
    expect(scopeAt).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("list:companies/acme")).toBeGreaterThan(scopeAt);
    expect(calls.indexOf("summary:companies/acme")).toBeGreaterThan(scopeAt);
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
    expect(home.textContent).toContain("Most linked");
    expect(home.textContent).toContain("pricing");
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

  it("reads notes through the capped reader and never the whole file", async () => {
    const { host, calls } = await render({ path: "companies/acme/knowledge/pricing.md" });
    expect(host.querySelector(".note-title")?.textContent).toBe("Pricing");
    expect(calls).toContain("read:companies/acme/knowledge/pricing.md");
    expect(calls.some((c) => c.startsWith("whole:"))).toBe(false);
  });

  it("says when a note is too large to show whole and offers the full file", async () => {
    const { host, calls } = await render({ path: BIG_NOTE });
    const banner = host.querySelector('[data-testid="note-truncated"]')!;
    expect(banner.textContent).toContain("3.0 MB");
    banner.querySelector("button")!.click();
    await settle();
    expect(calls).toContain(`reveal:${BIG_NOTE}`);
  });

  it("opens the quick switcher on Cmd+O and jumps to a file", async () => {
    const { host } = await render();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", metaKey: true }));
    await settle();
    const input = host.querySelector<HTMLInputElement>('[data-testid="quick-switcher"] input')!;
    input.value = "tone";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await new Promise((r) => setTimeout(r, 90));
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
