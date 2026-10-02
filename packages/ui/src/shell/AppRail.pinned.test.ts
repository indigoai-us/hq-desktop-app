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
