// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import AppRail from "./AppRail.svelte";
import { railItems, type RailItem } from "./app-rail.js";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "AppRail.svelte"),
  "utf8",
);

const items: RailItem[] = railItems(
  [
    { uid: "co_quiet", label: "Indigo", liveCount: 0 },
    { uid: "co_live", label: "LiveRecover", liveCount: 1 },
  ],
  "You",
);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("pinned company tiles (US-004)", () => {
  it("shows a pulsing live dot only on the company with someone online", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AppRail, {
      target: host,
      props: { items, activeId: "company:co_quiet", onselect: () => {} },
    });
    await tick();
    const dots = host.querySelectorAll("[data-testid='rail-live-dot']");
    expect(dots).toHaveLength(1);
    const liveButton = dots[0]!.closest("button");
    expect(liveButton?.getAttribute("aria-label")).toBe("LiveRecover");
    expect(host.querySelector("[data-testid='rail-company']")?.textContent).toContain("IN");
    expect(host.innerHTML).not.toContain("co_live");
    expect(host.innerHTML).not.toContain("co_quiet");
  });

  it("draws hairlines between the rail groups, logomarks in tiles, and the own live dot", async () => {
    const withIcon = railItems(
      [
        { uid: "co_a", label: "Indigo", liveCount: 0, iconUrl: "data:image/svg+xml,%3Csvg/%3E" },
        { uid: "co_b", label: "LiveRecover", liveCount: 0 },
      ],
      "You",
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AppRail, {
      target: host,
      props: { items: withIcon, activeId: null, youLive: true, onselect: () => {} },
    });
    await tick();
    const nav = host.querySelector("[data-testid='app-rail']")!;
    const order = [...nav.children].map((el) =>
      el.getAttribute("data-testid") === "app-rail-sep"
        ? "|"
        : (el.querySelector("button")?.getAttribute("data-rail-id") ??
          el.getAttribute("data-rail-id") ??
          el.getAttribute("data-testid")),
    );
    const seps = order.map((id, i) => (id === "|" ? i : -1)).filter((i) => i >= 0);
    expect(seps).toHaveLength(3);
    expect(order[seps[0]! - 1]).toBe("meetings");
    expect(order[seps[1]! - 1]).toBe("more-companies");
    expect(order[seps[2]! + 1]).toBe("you");
    const tiles = host.querySelectorAll("[data-testid='rail-company']");
    expect(tiles[0]!.querySelector("img, svg, .company-icon")).not.toBeNull();
    expect(tiles[1]!.textContent).toContain("LI");
    expect(host.querySelector("[data-testid='rail-you-live']")).not.toBeNull();
  });

  it("stops the live-dot pulse under reduced motion", () => {
    expect(source).toContain("@keyframes dot-pulse");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none/);
  });

  it("reorders pins on drop without writing company ids into the DOM", async () => {
    const order: string[][] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AppRail, {
      target: host,
      props: {
        items,
        activeId: null,
        onselect: () => {},
        onreorderpins: (from: string, to: string) => order.push([from, to]),
      },
    });
    await tick();
    const buttons = [...host.querySelectorAll("[data-testid='rail-company']")];
    expect(buttons).toHaveLength(2);
    buttons[1]!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    buttons[0]!.dispatchEvent(over);
    buttons[0]!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(order).toEqual([["co_live", "co_quiet"]]);
  });
});

// WebKit, the macOS app's engine, does not focus a clicked button. The More
// companies and account popovers return focus to whatever held it on open,
// so the rail button focuses itself before opening them.
describe("AppRail popover openers", () => {
  it("focuses More companies on click so its popover can return focus there", async () => {
    let opened = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AppRail, {
      target: host,
      props: { items, activeId: "company:co_quiet", onselect: () => {}, onmore: () => (opened += 1) },
    });
    await tick();
    const more = host.querySelector<HTMLButtonElement>("[data-testid='rail-more-companies']")!;
    (document.activeElement as HTMLElement | null)?.blur();
    more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toBe(1);
    expect(document.activeElement).toBe(more);
  });
});

// The rail must never yield width to a wide sibling (the Meetings canvas,
// a long channel list): a flex item with a shrinkable basis collapses to a
// sliver in a 1280 px window. Lock the fixed 56 px column.
describe("AppRail fixed width", () => {
  const rule = source.match(/\.app-rail\s*\{([^}]*)\}/)?.[1] ?? "";

  it("is a non-shrinking 56 px column", () => {
    expect(rule).toMatch(/flex:\s*0 0 56px;/);
    expect(rule).toMatch(/(^|\s)width:\s*56px;/);
    expect(rule).not.toMatch(/min-width:\s*0/);
  });
});
