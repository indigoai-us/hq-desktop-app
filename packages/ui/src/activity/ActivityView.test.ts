// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ActivityView from "./ActivityView.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

describe("ActivityView tokens", () => {
  it("shows 30 day bars with weekends dimmed on the Tokens tab", async () => {
    host = document.createElement("div");
    document.body.append(host);
    component = mount(ActivityView, {
      target: host,
      props: { slug: "indigo", companyLabel: "Indigo" },
    });
    flushSync();
    const tokens = [...host.querySelectorAll("button")].find((button) => button.textContent === "Tokens");
    tokens?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    await expect
      .poll(() => host?.querySelector("[data-testid='token-day-strip']")?.getAttribute("data-days"))
      .toBe("30");
    const strip = host?.querySelector("[data-testid='token-day-strip']");
    const bars = [...(strip?.querySelectorAll("i") ?? [])];
    expect(bars).toHaveLength(30);
    expect(bars.some((bar) => bar.getAttribute("data-weekend") === "true")).toBe(true);
    expect(bars.filter((bar) => bar.getAttribute("data-weekend") === "true").length).toBeLessThan(30);
  });
});
