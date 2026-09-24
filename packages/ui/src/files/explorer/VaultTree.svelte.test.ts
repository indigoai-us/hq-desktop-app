// @vitest-environment happy-dom

// VaultTree keeps only the rows in view in the DOM, so a folder with
// thousands of files costs the same to render as a small one.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import VaultTree from "./VaultTree.svelte";
import type { Vault } from "./vault-model.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const ACME: Vault = { id: "company:acme", kind: "company", label: "Acme", root: "companies/acme", slug: "acme" };

const FILE_COUNT = 5000;
const name = (i: number) => `note-${String(i).padStart(5, "0")}.md`;
const entries = Array.from({ length: FILE_COUNT }, (_, i) => ({
  name: name(i),
  path: `companies/acme/${name(i)}`,
  isDir: false,
  hasChildren: false,
}));

async function settle(times = 6) {
  for (let i = 0; i < times; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

async function render(activePath: string | null = null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(VaultTree, {
    target: host,
    props: {
      vault: ACME,
      listDir: async () => ({ ok: true as const, value: entries }),
      activePath,
      showSystem: false,
      reloadKey: 0,
      onopen: () => {},
    },
  });
  await settle();
  return host;
}

const rendered = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="vault-tree-row"]')];

describe("VaultTree", () => {
  it("renders only a window of rows for a huge folder", async () => {
    const el = await render();
    const rows = rendered(el);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0].dataset.treePath).toBe(`companies/acme/${name(0)}`);
    // The spacer still gives the scrollbar the whole list's height.
    const spacer = el.querySelector<HTMLElement>(".vt-rows")!;
    expect(spacer.style.height).toBe(`${FILE_COUNT * 26}px`);
  });

  it("renders the rows under the scroll position", async () => {
    const el = await render();
    const tree = el.querySelector<HTMLElement>('[data-testid="vault-tree"]')!;
    tree.scrollTop = 2600 * 26;
    tree.dispatchEvent(new Event("scroll"));
    await settle();
    const paths = rendered(el).map((r) => r.dataset.treePath);
    expect(paths).toContain(`companies/acme/${name(2600)}`);
    expect(paths).not.toContain(`companies/acme/${name(0)}`);
  });

  it("scrolls the open file into view", async () => {
    const el = await render(`companies/acme/${name(4000)}`);
    const paths = rendered(el).map((r) => r.dataset.treePath);
    expect(paths).toContain(`companies/acme/${name(4000)}`);
  });
});
