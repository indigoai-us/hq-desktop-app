// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import AppRail from "./AppRail.svelte";
import { railItems } from "./app-rail.js";

const items = railItems([{ uid: "co_a", label: "Indigo", liveCount: 0 }], "You");
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("AppRail: a brief run in progress", () => {
  it("shows a slim progress bar on the Brief item from any page, and clicking opens Brief", async () => {
    const onselect = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AppRail, {
      target: host,
      props: { items, activeId: "home", onselect, briefRun: { progress: 0.42, step: "Sweeping your day" } },
    });
    await tick();
    const bar = host.querySelector("[data-testid='rail-brief-progress']")!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    const button = bar.closest("button")!;
    expect(button.getAttribute("data-rail-id")).toBe("brief");
    button.click();
    expect(onselect).toHaveBeenCalledWith(expect.objectContaining({ kind: "brief" }));
  });

  it("shows no bar when no run is active", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AppRail, { target: host, props: { items, activeId: null, onselect: () => {} } });
    await tick();
    expect(host.querySelector("[data-testid='rail-brief-progress']")).toBeNull();
  });
});
