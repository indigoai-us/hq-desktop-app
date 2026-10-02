// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CompanySidepane from "./CompanySidepane.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

describe("CompanySidepane (console-rail US-007)", () => {
  it("renders the header, 15 rows, and a pinned settings footer", () => {
    const onselect = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(CompanySidepane, {
        target,
        props: {
          company: { uid: "co_indigo", label: "Indigo", slug: null },
          selectedId: "workers",
          onselect,
        },
      }),
    );
    flushSync();
    const header = target.querySelector("[data-testid='company-sidepane-header']");
    expect(header?.textContent).toContain("Indigo");
    expect(target.querySelector("[data-testid='company-sidepane-live']")?.textContent?.trim()).toBe("0");
    const rows = target.querySelectorAll("[data-testid='sidepane-body'] [data-testid='sidepane-row']");
    expect(rows).toHaveLength(14);
    const footer = target.querySelector("[data-testid='sidepane-footer']");
    const settings = footer?.querySelector("[data-testid='company-sidepane-settings']");
    expect(settings?.textContent?.trim()).toBe("Company settings");
    expect(
      target.querySelector("[data-row-id='workers']")?.getAttribute("aria-current"),
    ).toBe("page");
    (target.querySelector("[data-row-id='team']") as HTMLButtonElement).click();
    (settings as HTMLButtonElement).click();
    expect(onselect.mock.calls).toEqual([["team"], ["company-settings"]]);
  });
});
