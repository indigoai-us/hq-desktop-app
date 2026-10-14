// @vitest-environment happy-dom

// BLANK-2: a goals read that fails with nothing cached shows only the failed
// line and Try again. "0 objectives · 0 KRs" waits for a read that succeeded.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
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
  vi.restoreAllMocks();
});

describe("GoalsView failed read (BLANK-2)", () => {
  it("shows the failed line and Try again, and no zero counts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ipc = (): Promise<unknown> => Promise.reject(new Error("HTTP 500"));
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "blank-2-goals" },
    });
    await vi.waitFor(() => expect(host?.querySelector("[data-testid='goals-load-error']")).toBeTruthy());
    flushSync();
    const text = host.textContent ?? "";
    expect(host.querySelector("[data-testid='goals-retry']")).toBeTruthy();
    expect(text).not.toMatch(/\b0 objectives\b/);
    expect(text).not.toContain("KRs");
    expect(host.querySelector("[data-testid='empty-goals-state']")).toBeNull();
    expect(text).not.toContain("HTTP 500");
  });
});
