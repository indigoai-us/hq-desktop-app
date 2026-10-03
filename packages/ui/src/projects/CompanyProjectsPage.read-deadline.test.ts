// @vitest-environment happy-dom

// BLANK-1: a projects read that never answers must not hold the board
// skeleton forever; after the shared read deadline the page shows plain copy
// and Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { expectPendingRead } from "../common/read-loader.test-support.js";
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

describe("CompanyProjectsPage pending read (BLANK-3)", () => {
  it("a projects read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
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
    await expectPendingRead(host, "projects-loader");
    // BLANK-2: no zero count or empty board next to the failed read.
    expect(host.querySelector("[data-testid='projects-count']")).toBeNull();
    expect(host.querySelector("[data-testid='empty-projects-state']")).toBeNull();
    expect(host.textContent).not.toMatch(/Nothing yet|Nothing live/);
  });
});
