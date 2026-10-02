// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import OutpostPage from "./OutpostPage.svelte";
import { writeOutpostCache, lastResultLabel, type OutpostRefresher } from "./outpost-model.js";
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

  it("disables actions and shows the retry banner when the host is unreachable", () => {
    const cache = fixtureOutpost();
    cache.unreachable = true;
    cache.host.online = false;
    cache.retryInSec = 22;
    writeOutpostCache("personal", cache);
    const target = mountPage();
    const banner = target.querySelector("[data-testid='outpost-offline-banner']");
    expect(banner?.textContent).toContain("No report since 10:52");
    const terminal = [...target.querySelectorAll("button")].find((b) => b.textContent === "Open terminal");
    expect(terminal?.hasAttribute("disabled")).toBe(true);
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

  it("New job opens a blank sheet and Edit keeps the job's values (QA-053)", () => {
    const cache = fixtureOutpost();
    writeOutpostCache("personal", cache);
    const target = mountPage();
    (target.querySelector("[data-testid='new-job']") as HTMLButtonElement).click();
    flushSync();
    const sheet = target.querySelector("[data-testid='edit-job-sheet']");
    expect(sheet?.querySelector("[role='dialog']")?.getAttribute("aria-label")).toBe("New job");
    const name = target.querySelector("[data-testid='job-name-input']") as HTMLInputElement;
    expect(name.value).toBe("");
    expect(sheet?.textContent).not.toContain(cache.jobs[0].name);
    const prompt = sheet?.querySelector("textarea") as HTMLTextAreaElement | null;
    if (prompt) expect(prompt.value).toBe("");
    // Saving without a name is refused; with a name it adds a new job.
    const save = () => [...target.querySelectorAll("button")].find((b) => b.textContent === "Save")?.click();
    save();
    flushSync();
    expect(target.querySelector("[data-testid='edit-job-sheet']")).not.toBeNull();
    name.value = "Weekly digest";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    save();
    flushSync();
    expect(target.querySelector("[data-testid='edit-job-sheet']")).toBeNull();
    expect(target.textContent).toContain("Weekly digest");
    expect(target.textContent).toContain(cache.jobs[0].name);

    const edit = [...target.querySelectorAll("button")].find((b) => b.textContent === "Edit");
    edit?.click();
    flushSync();
    const editSheet = target.querySelector("[data-testid='edit-job-sheet']");
    expect(editSheet?.querySelector("[role='dialog']")?.getAttribute("aria-label")).toBe("Edit job");
    expect(editSheet?.textContent).toContain(cache.jobs[0].name);
    expect(target.querySelector("[data-testid='job-name-input']")).toBeNull();
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
