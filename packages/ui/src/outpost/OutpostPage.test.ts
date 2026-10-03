// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import OutpostPage from "./OutpostPage.svelte";
import { LOADING_RETRY_AFTER_MS } from "../common/read-deadline.js";
import { expectPendingRead } from "../common/read-loader.test-support.js";
import { clearOutpostCache, EMPTY_INTERPOLATION, writeOutpostCache, lastResultLabel, type OutpostRefresher } from "./outpost-model.js";
import { fixtureOutpost } from "./outpost.fixture.js";

describe("US-034 OutpostPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mountPage(refresh?: OutpostRefresher) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OutpostPage, { target, props: { refresh } });
    flushSync();
    return target;
  }

  function openTab(target: HTMLElement, label: string): void {
    [...target.querySelectorAll("nav button")].find((b) => b.textContent === label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
  }

  it("a hung read keeps the shared loader and is never turned into a failure (QA-084, BLANK-3)", async () => {
    vi.useFakeTimers();
    clearOutpostCache("personal");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = mountPage(() => new Promise(() => {}));
    expect(target.querySelector("[data-testid='outpost-freshness']")?.textContent).toBe("Refreshing…");
    await expectPendingRead(target, "outpost-loader");
    await vi.advanceTimersByTimeAsync(LOADING_RETRY_AFTER_MS + 1);
    flushSync();
    expect(errors).not.toHaveBeenCalled();
    expect(target.querySelector("[data-testid='outpost-load-error']")).toBeNull();
    expect(target.textContent).not.toMatch(/Couldn't/);
  });

  it("reads on open even when the window reports hidden, so loading always ends (QA-084)", async () => {
    clearOutpostCache("personal");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    let calls = 0;
    const target = mountPage(async () => {
      calls += 1;
      return { ...fixtureOutpost(), fetchedAt: new Date().toISOString() };
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.waitFor(() => expect(target.querySelector("[data-testid='outpost-loading']")).toBeNull());
    expect(target.querySelector("[data-testid='outpost-freshness']")?.textContent).not.toBe("Refreshing…");
  });

  it("never shows raw transport text when the read fails (QA-084)", async () => {
    clearOutpostCache("personal");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const target = mountPage(async () => {
      throw new Error("outpost status: http-504 Endpoint request timed out");
    });
    await vi.waitFor(() => expect(target.querySelector("[data-testid='outpost-load-error']")).not.toBeNull());
    expect(target.textContent).not.toMatch(/http-504|Endpoint request/);
  });

  it("a failed first read shows an error with Try again instead of loading forever (QA-084)", async () => {
    clearOutpostCache("personal");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const target = mountPage(async () => {
      calls += 1;
      throw new Error("boom");
    });
    await vi.waitFor(() => expect(target.querySelector("[data-testid='outpost-load-error']")).not.toBeNull());
    expect(target.querySelector("[data-testid='outpost-loading']")).toBeNull();
    (target.querySelector("[data-testid='outpost-try-again']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it("shows one state and the retry banner when the host is unreachable (OWNER-R19)", () => {
    const cache = fixtureOutpost();
    cache.unreachable = true;
    cache.host.online = false;
    cache.retryInSec = 22;
    writeOutpostCache("personal", cache);
    const target = mountPage();
    const banner = target.querySelector("[data-testid='outpost-offline-banner']");
    expect(banner?.textContent).toContain("No report for 14 minutes.");
    expect(banner?.textContent).not.toContain("since");
    expect(banner?.getAttribute("title")).toBeTruthy();
    const state = target.querySelector("[data-testid='outpost-online']")?.textContent ?? "";
    expect(state).toMatch(/^Unreachable since /);
    expect(target.textContent).not.toMatch(/\b(running|Offline)\b/);
  });

  it("is a status view: Open console opens the web console's Outpost page; no management control remains (OWNER-R19)", () => {
    writeOutpostCache("personal", fixtureOutpost());
    const openExternal = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OutpostPage, { target, props: { openExternal } });
    flushSync();
    const open = target.querySelector<HTMLButtonElement>("[data-testid='outpost-open-console']");
    expect(open?.textContent?.trim()).toBe("Open console");
    open!.click();
    expect(openExternal).toHaveBeenCalledWith("https://hq.computer/personal/outpost");
    const labels = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());
    for (const gone of ["Open terminal", "Self-update", "Restart", "New job", "Edit", "Pause", "Resume", "Logs", "Settings"]) {
      expect(labels, gone).not.toContain(gone);
    }
    expect(target.querySelector("[data-testid='new-job']")).toBeNull();
  });

  it("titles the Outpost by name, never by its raw id; the id is muted with a copy control (OWNER-R19)", () => {
    const cache = fixtureOutpost();
    cache.host.name = "outpost-54388428-90a1-7067-0000-000000000000";
    cache.host.region = "us-east-1";
    writeOutpostCache("personal", cache);
    const target = mountPage();
    expect(target.querySelector("[data-testid='outpost-title']")?.textContent).toBe("Outpost · us-east-1");
    expect(target.querySelector("[data-testid='outpost-pane-host']")?.textContent).not.toContain("outpost-5438");
    expect(target.querySelector("[data-testid='outpost-id']")?.textContent).toContain("outpost-54388428");
    expect(target.querySelector("[data-testid='outpost-copy-id']")).not.toBeNull();
  });

  it("says no report has been received when the report time is missing (QA-097)", () => {
    const cache = fixtureOutpost();
    cache.unreachable = true;
    cache.host.online = false;
    cache.host.lastHeartbeatAt = "";
    cache.host.lastHeartbeatIso = undefined;
    writeOutpostCache("personal", cache);
    const target = mountPage();
    const banner = target.querySelector("[data-testid='outpost-offline-banner']");
    const text = (banner?.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toContain("Host unreachable. No report received yet.");
    expect(text).not.toMatch(EMPTY_INTERPOLATION);
    expect(banner?.hasAttribute("title")).toBe(false);
  });

  it("keeps the full last result readable in the job row (QA-052)", () => {
    const cache = fixtureOutpost();
    writeOutpostCache("personal", cache);
    const target = mountPage();
    const cells = [...target.querySelectorAll<HTMLElement>("[data-testid='job-last-result']")];
    expect(cells.length).toBe(cache.jobs.length);
    cells.forEach((cell, i) => {
      const label = lastResultLabel(cache.jobs[i], Date.now());
      expect(cell.textContent).toBe(label);
      expect(cell.getAttribute("title")).toBe(label);
      expect(cell.classList.contains("result")).toBe(true);
    });
  });

  describe("QA-069 freshness", () => {
    const T0 = Date.parse("2026-10-02T18:00:00Z");

    it("re-renders relative times every 30 s from absolute timestamps", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      vi.spyOn(console, "error").mockImplementation(() => {});
      writeOutpostCache("personal", fixtureOutpost(T0));
      const target = mountPage();
      const attio = () => [...target.querySelectorAll("[data-testid='job-last-result']")][1]?.textContent;
      const next = () => [...target.querySelectorAll("[data-testid='job-next-run']")][1]?.textContent;
      expect(attio()).toBe("failed · 19m ago · 3 in a row");
      expect(next()).toBe("in 33m");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      flushSync();
      expect(attio()).toBe("failed · 29m ago · 3 in a row");
      expect(next()).toBe("in 23m");
      expect(target.querySelector("[data-testid='run-when']")?.textContent).toContain("2h ago");
    });

    it("refreshes from the Outpost on open, merges, and says when it updated", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      writeOutpostCache("personal", fixtureOutpost(T0 - 3 * 3_600_000));
      const fresh = fixtureOutpost(T0);
      fresh.jobs[1].lastResultNote = "4 in a row";
      const refresh = vi.fn<OutpostRefresher>().mockResolvedValue(fresh);
      const target = mountPage(refresh);
      await vi.advanceTimersByTimeAsync(0);
      flushSync();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(target.textContent).toContain("failed · 19m ago · 4 in a row");
      expect(target.querySelector("[data-testid='outpost-freshness']")?.textContent).toBe("Updated just now");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("keeps the cache, logs, and shows the stale state when refresh fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const cache = fixtureOutpost(T0 - 2 * 3_600_000);
      cache.fetchedAt = new Date(T0 - 2 * 3_600_000).toISOString();
      writeOutpostCache("personal", cache);
      const refresh = vi.fn<OutpostRefresher>().mockRejectedValue(new Error("HTTP 502"));
      const target = mountPage(refresh);
      await vi.advanceTimersByTimeAsync(0);
      flushSync();
      const fresh = target.querySelector("[data-testid='outpost-freshness']")?.textContent;
      expect(fresh).toBe("Couldn't refresh · showing data from 2h ago");
      expect(fresh).not.toContain("502");
      expect(errors).toHaveBeenCalledWith("[outpost] refresh failed", expect.any(Error));
      expect(target.querySelectorAll("[data-testid='job-last-result']").length).toBe(cache.jobs.length);
    });
  });
});

describe("QA-096 Outpost sidebar host name", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  it("truncates a 120-character host name inside the fixed sidebar column", () => {
    const cache = fixtureOutpost();
    cache.host.name = "outpost-" + "x".repeat(112);
    expect(cache.host.name.length).toBe(120);
    writeOutpostCache("personal", cache);
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OutpostPage, { target, props: {} });
    flushSync();

    const page = target.querySelector<HTMLElement>("[data-testid='outpost-page']")!;
    const pane = target.querySelector<HTMLElement>("aside.pane")!;
    const host = target.querySelector<HTMLElement>("[data-testid='outpost-pane-host']")!;
    const label = host.querySelector<HTMLElement>(".label")!;

    // The full value stays reachable as a tooltip.
    expect(host.getAttribute("title")).toContain(cache.host.name);
    expect(label.textContent).toContain(cache.host.name);

    // Master-detail pin: list column fixed, detail flexes.
    expect(getComputedStyle(page).gridTemplateColumns).toBe("260px minmax(0, 1fr)");

    // The sidebar clips its content, and the label truncates rather than overflowing.
    expect(getComputedStyle(pane).overflow).toBe("hidden");
    expect(getComputedStyle(pane).minWidth).toBe("0");
    expect(getComputedStyle(host).minWidth).toBe("0");
    expect(getComputedStyle(host).maxWidth).toBe("100%");
    const ls = getComputedStyle(label);
    expect(ls.overflow).toBe("hidden");
    expect(ls.textOverflow).toBe("ellipsis");
    expect(ls.whiteSpace).toBe("nowrap");
    expect(ls.minWidth).toBe("0");

    // Bounding box stays within the sidebar (happy-dom reports zero-size boxes, so this
    // guards the relation; the computed styles above carry the real-layout contract).
    const pr = pane.getBoundingClientRect();
    const lr = label.getBoundingClientRect();
    expect(lr.right).toBeLessThanOrEqual(pr.right);
    expect(lr.left).toBeGreaterThanOrEqual(pr.left);

    // Every sidebar nav row truncates the same way.
    for (const b of pane.querySelectorAll<HTMLElement>("nav button .label")) {
      expect(getComputedStyle(b).textOverflow).toBe("ellipsis");
    }
  });
});

describe("AUDIT-2 Outpost filter labels", () => {
  it("renders job and run filter tabs and run statuses in sentence case", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(OutpostPage, { target, props: {} });
    flushSync();
    const tabs = [...target.querySelectorAll(".tabs button:not([data-testid])")].map((b) => b.textContent?.trim() ?? "");
    expect(tabs).toEqual(expect.arrayContaining(["All", "Active", "Paused", "Failing", "OK", "Failed", "Running"]));
    expect(tabs.filter((t) => /^[a-z]/.test(t))).toEqual([]);
    const statuses = [...target.querySelectorAll(".run .st")].map((s) => s.textContent?.trim() ?? "");
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.filter((t) => /^[a-z]/.test(t))).toEqual([]);
    await unmount(component);
  });
});
