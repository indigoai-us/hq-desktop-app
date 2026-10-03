// @vitest-environment happy-dom

// BLANK-1: a cloud-bots read that never answers must not hold the shimmer
// forever; after the shared read deadline the page shows plain copy and
// Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { READ_DEADLINE_MS } from "../common/read-deadline.js";
import BotsPage from "./BotsPage.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BotsPage read deadline (BLANK-1)", () => {
  it("a roster read that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const okEmpty = async () => ({ ok: true, value: [] });
    const api = (own: Record<string, unknown>) =>
      new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : okEmpty) });
    const adapter = new Proxy({
      agents: api({ listMobileRoster: () => new Promise(() => {}) }),
    } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : k === "isAvailable" ? () => false : api({})) });
    component = mount(BotsPage, { target: document.body, props: { companyUid: "cmp_blank1", adapter, localBots: [], companies: [] } as never });
    flushSync();
    expect(document.querySelector("[data-testid='bots-shimmer']")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector("[data-testid='bots-shimmer']")).toBeNull();
    expect(document.querySelector("[data-testid='bots-load-error']")?.textContent).toContain("Couldn't read this company's cloud bots.");
    expect(document.querySelector("[data-testid='bots-retry']")).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });
});
