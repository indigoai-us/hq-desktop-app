// @vitest-environment happy-dom

// BLANK-1: a cloud-bots read that never answers must not hold the loader
// forever; after the shared read deadline the page shows plain copy and
// Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { expectPendingRead } from "../common/read-loader.test-support.js";
import BotsPage from "./BotsPage.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BotsPage pending read (BLANK-3)", () => {
  it("a roster read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
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
    await expectPendingRead(document, "bots-loader");
    // BLANK-2: the failed read with nothing loaded shows no zero count.
    expect(document.querySelector("[data-testid='bots-count']")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0 bots\b/);
    expect(document.querySelector("[data-testid='bots-empty']")).toBeNull();
  });
});
