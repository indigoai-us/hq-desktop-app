// @vitest-environment happy-dom

// BLANK-1: a goals read that never answers must not hold the skeleton
// forever; after the shared read deadline the page shows plain copy and
// Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { expectPendingRead } from "../common/read-loader.test-support.js";
import { fakeProjectsApi } from "../projects/testing.js";
import GoalsView from "./GoalsView.svelte";

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

describe("GoalsView pending read (BLANK-3)", () => {
  it("a goals read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ipc = (): Promise<unknown> => new Promise(() => {});
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "blank-1-goals" },
    });
    flushSync();
    expect(host.querySelector("[data-testid='goals-loader']")).toBeTruthy();
    await expectPendingRead(host, "goals-loader");
  });
});
