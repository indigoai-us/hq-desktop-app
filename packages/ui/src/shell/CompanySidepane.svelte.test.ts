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

  it("adds Live now and Idle rosters on Atlas, with skeleton rows while names load (US-009)", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({
      company: { uid: "co_indigo", label: "Indigo", slug: null },
      selectedId: "atlas" as string | null,
      rosterLoading: true,
      roster: [
        { uid: "u_zed", name: "Zed", kind: "human" as const, live: true },
        { uid: "b_scout", name: "Scout", kind: "bot" as const, live: false },
      ],
    });
    mounted.push(mount(CompanySidepane, { target, props }));
    flushSync();
    // Loading: real nav rows plus a skeleton roster, no spinner.
    expect(target.querySelectorAll("[data-testid='sidepane-body'] [data-testid='sidepane-row']")).toHaveLength(14);
    expect(target.querySelector("[data-testid='company-sidepane-roster-skeleton']")).not.toBeNull();
    expect(target.textContent).not.toContain("Live now");

    props.rosterLoading = false;
    flushSync();
    expect(target.querySelector("[data-testid='company-sidepane-roster-skeleton']")).toBeNull();
    expect(target.textContent).toContain("Live now");
    expect(target.textContent).toContain("Idle");
    expect(target.querySelector("[data-row-id='person:u_zed']")).not.toBeNull();
    expect(target.querySelector("[data-row-id='person:b_scout']")).not.toBeNull();
    expect(target.querySelector("[data-row-id='atlas']")?.getAttribute("aria-current")).toBe("page");

    // Other company pages keep the plain sections.
    props.selectedId = "projects";
    flushSync();
    expect(target.textContent).not.toContain("Live now");
  });
});
