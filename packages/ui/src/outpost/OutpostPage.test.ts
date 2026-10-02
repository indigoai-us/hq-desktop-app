// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import OutpostPage from "./OutpostPage.svelte";
import { writeOutpostCache, fixtureOutpost } from "./outpost-model.js";

describe("US-034 OutpostPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  function mountPage() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OutpostPage, { target });
    flushSync();
    return target;
  }

  it("disables actions and shows the retry banner when the host is unreachable", () => {
    const cache = fixtureOutpost();
    cache.unreachable = true;
    cache.host.online = false;
    cache.retryInSec = 22;
    writeOutpostCache("personal", cache);
    const target = mountPage();
    const banner = target.querySelector("[data-testid='outpost-offline-banner']");
    expect(banner?.textContent).toContain("No heartbeat since 10:52");
    expect(banner?.textContent).toContain("0:22");
    const terminal = [...target.querySelectorAll("button")].find((b) => b.textContent === "Open terminal");
    expect(terminal?.hasAttribute("disabled")).toBe(true);
  });

  it("rejects a bad custom cron and lists five runs for a valid one", () => {
    writeOutpostCache("personal", fixtureOutpost());
    const target = mountPage();
    const edit = [...target.querySelectorAll("button")].find((b) => b.textContent === "Edit");
    edit?.click();
    flushSync();
    const custom = [...target.querySelectorAll("button")].find((b) => b.textContent === "custom");
    custom?.click();
    flushSync();
    const input = target.querySelector("[data-testid='cron-input']") as HTMLInputElement;
    input.value = "nope";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelector("[data-testid='cron-error']")?.textContent).toContain("five fields");
    input.value = "0 * * * *";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(target.querySelectorAll("[data-testid='cron-next'] li")).toHaveLength(5);
  });

  it("streams a new log line into the virtual window", () => {
    writeOutpostCache("personal", fixtureOutpost());
    const target = mountPage();
    [...target.querySelectorAll("button")].find((b) => b.textContent === "Logs")?.click();
    flushSync();
    const before = target.querySelectorAll("[data-testid='log-line']").length;
    [...target.querySelectorAll("button")].find((b) => b.textContent === "Follow")?.click();
    flushSync();
    expect(target.querySelectorAll("[data-testid='log-line']").length).toBe(before + 1);
    expect(target.textContent).toContain("tail · heartbeat ok");
  });
});
