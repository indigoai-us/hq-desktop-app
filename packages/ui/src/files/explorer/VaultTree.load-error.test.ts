// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import VaultTree from "./VaultTree.svelte";
import type { Vault } from "./vault-model.js";

// AUDIT-3: an unreadable vault root shows plain copy and Try again, never
// the host's error text.
let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

const ACME: Vault = { id: "company:acme", kind: "company", label: "Acme", root: "companies/acme", slug: "acme" };

async function settle(times = 6) {
  for (let i = 0; i < times; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

describe("VaultTree failed read (AUDIT-3)", () => {
  it("shows plain copy with Try again and recovers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(VaultTree, {
      target: host,
      props: {
        vault: ACME,
        listDir: async () =>
          fail
            ? { ok: false as const, message: "list_hq_dir: ENOENT /Users/qa/HQ/companies/acme" }
            : { ok: true as const, value: [{ name: "a.md", path: "companies/acme/a.md", isDir: false, hasChildren: false }] },
        activePath: null,
        showSystem: false,
        reloadKey: 0,
        onopen: () => {},
      },
    });
    await settle();
    const box = host.querySelector("[data-testid='vault-tree-error']");
    expect(box?.textContent).toContain("Couldn't read this vault.");
    expect(host.textContent).not.toContain("ENOENT");
    expect(host.textContent).not.toContain("/Users/");
    fail = false;
    (host.querySelector("[data-testid='vault-tree-retry']") as HTMLButtonElement).click();
    await settle();
    expect(host.querySelector("[data-testid='vault-tree-error']")).toBeNull();
    expect(host.querySelectorAll("[data-testid='vault-tree-row']").length).toBe(1);
  });
});

describe("Library read errors never paint host text (AUDIT-3)", () => {
  it("assigns no res.message to a rendered error in the tree or the vault home", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "src/files/explorer");
    for (const file of ["VaultTree.svelte", "VaultExplorer.svelte"]) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, file).not.toMatch(/(rootError|summaryError|revealError)\s*=\s*res\.message/);
      expect(src, file).not.toMatch(/error:\s*res\.message/);
    }
  });
});
