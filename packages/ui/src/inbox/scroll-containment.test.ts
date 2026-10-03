// @vitest-environment happy-dom
/**
 * Scroll containment on long-list rows, and the inset focus ring that makes
 * paint containment safe. happy-dom does not compute scoped values, so the
 * assertions read the stylesheet the mounted view injects.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import NotificationsView from "./NotificationsView.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

async function injected(): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NotificationsView, {
    target: host,
    props: {
      api: {
        fetchNotifications: async () => ({ notifications: [] }),
        ackNotification: async () => {},
        readAllNotifications: async () => {},
        runNotificationAction: async () => ({}),
      },
    },
  });
  await tick();
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => css.includes("notif-row"))
    .join("\n");
}

function rule(css: string, selector: RegExp): string {
  const match = css.match(new RegExp(selector.source + "\\s*\\{([^}]*)\\}"));
  expect(match, selector.source).not.toBeNull();
  return match![1];
}

describe("notification feed scroll containment", () => {
  it("skips offscreen rows so scroll cost stops scaling with feed length", async () => {
    const row = rule(await injected(), /\.notif-row\.svelte-[\w-]+(?=\s*\{)/);
    expect(row).toContain("content-visibility: auto");
    expect(row).toContain("contain: content");
  });

  it("declares an intrinsic height, so skipped rows do not collapse the scrollbar", async () => {
    const row = rule(await injected(), /\.notif-row\.svelte-[\w-]+(?=\s*\{)/);
    expect(row).toMatch(/contain-intrinsic-size:\s*auto\s+\d+px/);
  });

  it("keeps the focus ring inset, which is what makes paint containment safe", async () => {
    const css = await injected();
    const focus = rule(css, /\.notif-row\.svelte-[\w-]+:focus-visible(?=\s*\{)/);
    expect(focus).toContain("outline");
    const offset = focus.match(/outline-offset:\s*(-?\d+)px/);
    expect(offset, "contained row must declare outline-offset").not.toBeNull();
    expect(Number(offset![1])).toBeLessThan(0);
  });
});
