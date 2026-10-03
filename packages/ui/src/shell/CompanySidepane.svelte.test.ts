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
  // OWNER-R24: Settings rows live in the list; no Company settings footer.
  it("renders the header and every row with Settings in the list and no footer", () => {
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
    // 14 earlier rows + Groups, General, Brand (Grants and Billing hidden: no manager role).
    expect(rows).toHaveLength(17);
    expect(target.querySelector("[data-testid='company-sidepane-settings']")).toBeNull();
    const settings = target.querySelector("[data-row-id='general']");
    expect(
      target.querySelector("[data-row-id='workers']")?.getAttribute("aria-current"),
    ).toBe("page");
    (target.querySelector("[data-row-id='team']") as HTMLButtonElement).click();
    (settings as HTMLButtonElement).click();
    expect(onselect.mock.calls).toEqual([["team"], ["general"]]);
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
    // Loading: real nav rows plus the roster loader.
    expect(target.querySelectorAll("[data-testid='sidepane-body'] [data-testid='sidepane-row']")).toHaveLength(17);
    expect(target.querySelector("[data-testid='company-sidepane-roster-loading']")).not.toBeNull();
    expect(target.textContent).not.toContain("Live now");

    props.rosterLoading = false;
    flushSync();
    expect(target.querySelector("[data-testid='company-sidepane-roster-loading']")).toBeNull();
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

  it("highlights the roster person filtering the map, and Atlas again when cleared (US-013)", () => {
    const onselect = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({
      company: { uid: "co_indigo", label: "Indigo", slug: null },
      selectedId: "atlas" as string | null,
      roster: [{ uid: "u_zed", name: "Zed", kind: "human" as const, live: true }],
      rosterSelected: "u_zed" as string | null,
      onselect,
    });
    mounted.push(mount(CompanySidepane, { target, props }));
    flushSync();
    const zed = target.querySelector("[data-row-id='person:u_zed']") as HTMLElement;
    expect(zed.getAttribute("aria-current")).toBe("page");
    expect(target.querySelector("[data-row-id='atlas']")?.getAttribute("aria-current")).toBeNull();
    zed.click();
    expect(onselect).toHaveBeenCalledWith("person:u_zed");

    props.rosterSelected = null;
    flushSync();
    expect(target.querySelector("[data-row-id='atlas']")?.getAttribute("aria-current")).toBe("page");
    expect(target.querySelector("[data-row-id='person:u_zed']")?.getAttribute("aria-current")).toBeNull();
  });
});
