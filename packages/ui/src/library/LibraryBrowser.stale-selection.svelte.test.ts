// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import LibraryBrowser from "./LibraryBrowser.svelte";
import { selectionInResults, toLibraryItems, type LibraryItems } from "./library.js";
import type { LibraryApi } from "@hq/platform";

const items: LibraryItems = {
  workers: [],
  skills: [
    {
      name: "investment-memo",
      description: "Draft an investment memo",
      scope: "company",
      company: "acme",
      path: "skills/investment-memo/SKILL.md",
      allowedTools: [],
    },
    {
      name: "signals",
      description: "Surface action items",
      scope: "company",
      company: "acme",
      path: "skills/signals/SKILL.md",
      allowedTools: [],
    },
  ],
};

describe("QA-102 library inspector follows the search results", () => {
  let host: HTMLDivElement;
  afterEach(() => host?.remove());

  it("selectionInResults drops a selection the results no longer contain", () => {
    const all = toLibraryItems(items);
    expect(selectionInResults(all[0], all)).toBe(all[0]);
    expect(selectionInResults(all[0], [all[1]])).toBeNull();
    expect(selectionInResults(null, all)).toBeNull();
  });

  it("clears the selected skill's inspector when a search matches nothing", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const library = {
      getSkillDetail: vi.fn(async () => ({ name: "investment-memo", body: "memo body" })),
    } as unknown as LibraryApi;
    const component = mount(LibraryBrowser, {
      target: host,
      props: { items, library, forcedFilter: "skills" },
    });
    await tick();
    const card = [...host.querySelectorAll<HTMLButtonElement>("button.lib-card")].find((b) =>
      b.textContent?.includes("investment-memo"),
    )!;
    card.click();
    flushSync();
    expect(host.querySelector('[data-testid="library-detail-panel"]')?.textContent).toContain(
      "investment-memo",
    );

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search library"]')!;
    search.value = "qa-no-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    await tick();
    expect(host.querySelector('[data-testid="library-detail-panel"]')).toBeNull();
    expect(host.textContent).not.toContain("investment-memo");
    expect(host.querySelector('[data-testid="library-empty"]')?.textContent).toContain(
      "qa-no-match",
    );

    // Clearing the search does not bring the stale inspector back.
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(host.querySelector('[data-testid="library-detail-panel"]')).toBeNull();
    unmount(component);
  });
});
