// @vitest-environment happy-dom

// BLANK-1: a projects read that never answers must not hold the board
// skeleton forever; after the shared read deadline the page shows plain copy
// and Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { READ_DEADLINE_MS } from "../common/read-deadline.js";
import { fakeProjectsApi } from "./testing.js";
import CompanyProjectsPage from "./CompanyProjectsPage.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CompanyProjectsPage read deadline (BLANK-1)", () => {
  it("a projects read that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ipc = (): Promise<unknown> => new Promise(() => {});
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CompanyProjectsPage, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "blank-1-projects" },
    });
    flushSync();
    expect(host.querySelector(".board-loading")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(host.querySelector(".board-loading")).toBeNull();
    expect(host.querySelector("[data-testid='projects-load-error']")?.textContent).toContain("Couldn't read this company's projects.");
    expect(host.querySelector("[data-testid='projects-retry']")).toBeTruthy();
    expect(logged).toHaveBeenCalled();
    // BLANK-2: no zero count or empty board next to the failed read.
    expect(host.querySelector("[data-testid='projects-count']")).toBeNull();
    expect(host.querySelector("[data-testid='empty-projects-state']")).toBeNull();
    expect(host.textContent).not.toMatch(/Nothing yet|Nothing live/);
  });
});
