// @vitest-environment happy-dom

// Large companies carry over a thousand deployments and policies. Both lists
// paint one page (LIST_PAGE_SIZE rows) and load the rest from "Show more",
// instead of mounting every row on open.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@hq/platform";
import DeploymentsPanel from "./DeploymentsPanel.svelte";
import BrainPage from "./brain/BrainPage.svelte";
import { configureCompanyApi, stopCompanyStore } from "./company-store.svelte";
import { LIST_PAGE_SIZE } from "../shell/list-paging.js";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  configureCompanyApi(null);
  stopCompanyStore();
  vi.restoreAllMocks();
});

describe("Deployments panel paging", () => {
  it("paints one page of 1,290 deployments and loads the next page on Show more", async () => {
    const rows = Array.from({ length: 1290 }, (_, i) => ({
      sub: `app-${i}`, url: `app-${i}.hq.computer`, state: "active", lastDeploy: "1d ago", size: "1 MB", ver: "v1", pwd: false,
    }));
    configureCompanyApi({ getDeployments: async () => ok(rows) } as never);
    component = mount(DeploymentsPanel, {
      target: document.body,
      props: { slug: "big-co", workflow: {} as never },
    });
    const rowCount = () => document.querySelectorAll(".deployment-list > *").length;
    await vi.waitFor(() => {
      flushSync();
      expect(rowCount()).toBe(LIST_PAGE_SIZE);
    });
    const more = document.querySelector("[data-testid='deployments-more']") as HTMLButtonElement;
    expect(more).toBeTruthy();
    more.click();
    flushSync();
    expect(rowCount()).toBe(LIST_PAGE_SIZE * 2);
  });
});

describe("Policies paging", () => {
  it("paints one page per group and shows every policy count", async () => {
    const slug = "big-co";
    const entries: Record<string, string> = {};
    for (let i = 0; i < 120; i++) {
      entries[`companies/${slug}/policies/p-${String(i).padStart(3, "0")}.md`] =
        `---\ntitle: Policy ${i}\nenforcement: ${i % 2 ? "hard" : "soft"}\n---\n# Rule\n`;
    }
    const files = {
      listDir: vi.fn(async (dir: string) =>
        ok(Object.keys(entries)
          .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
          .map((p) => ({ name: p.split("/").pop()!, path: p, isDir: false })))),
      getFileContent: vi.fn(async (p: string) => ok(entries[p] ?? "")),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "policies", slug, files: files as never, library: null, shell: null, settings: null },
    });
    const rowCount = () => document.querySelectorAll("[data-testid='policy-row']").length;
    await vi.waitFor(() => {
      flushSync();
      expect(rowCount()).toBe(LIST_PAGE_SIZE * 2);
    });
    // Section headers still count every policy, not just the painted page.
    const counts = [...document.querySelectorAll(".sec-count")].map((el) => el.textContent);
    expect(counts).toEqual(["60", "60"]);
    (document.querySelector("[data-testid='brain-show-more']") as HTMLButtonElement).click();
    flushSync();
    expect(rowCount()).toBe(120);
    expect(document.querySelector("[data-testid='brain-show-more']")).toBeNull();
  });
});
