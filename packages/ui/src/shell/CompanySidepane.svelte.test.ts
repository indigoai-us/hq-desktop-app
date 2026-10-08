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
    // 13 earlier rows + Groups, General, Brand (Grants and Billing hidden: no manager role).
    expect(rows).toHaveLength(16);
    expect(target.querySelector("[data-testid='company-sidepane-settings']")).toBeNull();
    const settings = target.querySelector("[data-row-id='general']");
    expect(
      target.querySelector("[data-row-id='workers']")?.getAttribute("aria-current"),
    ).toBe("page");
    (target.querySelector("[data-row-id='team']") as HTMLButtonElement).click();
    (settings as HTMLButtonElement).click();
    expect(onselect.mock.calls).toEqual([["team"], ["general"]]);
  });

  it("lists no Live now or Idle roster on Atlas, with no roster loader (US-009 removed)", () => {
    const onselect = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({
      company: { uid: "co_indigo", label: "Indigo", slug: null },
      selectedId: "atlas" as string | null,
      rosterLoading: true,
      roster: [
        { uid: "u_zed", name: "Zed", kind: "human" as const, live: true },
        { uid: "u_amy", name: "Amy", kind: "human" as const, live: false },
        { uid: "b_scout", name: "Scout", kind: "bot" as const, live: false },
      ],
      onselect,
    });
    mounted.push(mount(CompanySidepane, { target, props }));
    flushSync();
    const rowCount = () =>
      target.querySelectorAll("[data-testid='sidepane-body'] [data-testid='sidepane-row']").length;
    expect(rowCount()).toBe(16);
    expect(target.querySelector("[data-testid='company-sidepane-roster-loading']")).toBeNull();

    props.rosterLoading = false;
    flushSync();
    expect(rowCount()).toBe(16);
    expect(target.textContent).not.toContain("Live now");
    expect(target.textContent).not.toContain("Idle");
    expect(target.querySelector("[data-row-id^='person:']")).toBeNull();
    expect(target.querySelector("[data-row-id='invite-teammate']")).toBeNull();
    expect(target.querySelector("[data-row-id='atlas']")?.getAttribute("aria-current")).toBe("page");
  });

  it("keeps the Invite a teammate row on Atlas once the roster settles with one human (US-014)", () => {
    const onselect = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const props = $state({
      company: { uid: "co_indigo", label: "Indigo", slug: null },
      selectedId: "atlas" as string | null,
      rosterLoading: true,
      roster: [{ uid: "u_me", name: "Me", kind: "human" as const, live: true }],
      onselect,
    });
    mounted.push(mount(CompanySidepane, { target, props }));
    flushSync();
    expect(target.querySelector("[data-row-id='invite-teammate']")).toBeNull();

    props.rosterLoading = false;
    flushSync();
    const invite = target.querySelector("[data-row-id='invite-teammate']") as HTMLButtonElement;
    expect(invite).not.toBeNull();
    invite.click();
    expect(onselect).toHaveBeenCalledWith("invite-teammate");

    // Other company pages keep the plain sections.
    props.selectedId = "projects";
    flushSync();
    expect(target.querySelector("[data-row-id='invite-teammate']")).toBeNull();
  });

  it("draws an icon on every People row, Groups and Grants included", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(CompanySidepane, {
        target,
        props: {
          company: { uid: "co_indigo", label: "Indigo", slug: null },
          selectedId: "projects",
          canManage: true,
          onselect: vi.fn(),
        },
      }),
    );
    flushSync();
    for (const id of ["team", "bots", "groups", "grants"]) {
      const row = target.querySelector(`[data-row-id='${id}']`);
      expect(row, id).not.toBeNull();
      expect(row?.querySelector(".glyph svg"), id).not.toBeNull();
    }
    const groups = target.querySelector("[data-row-id='groups'] .glyph")?.innerHTML;
    const grants = target.querySelector("[data-row-id='grants'] .glyph")?.innerHTML;
    const team = target.querySelector("[data-row-id='team'] .glyph")?.innerHTML;
    expect(new Set([groups, grants, team]).size).toBe(3);
  });
});
