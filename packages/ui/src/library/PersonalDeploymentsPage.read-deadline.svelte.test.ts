// @vitest-environment happy-dom

// BLANK-1: deployments reads that never answer must not hold the skeleton
// forever; after the shared read deadline the page shows the failed-read
// line and Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { READ_DEADLINE_MS } from "../common/read-deadline.js";
import PersonalDeploymentsPage from "./PersonalDeploymentsPage.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PersonalDeploymentsPage read deadline (BLANK-1)", () => {
  it("reads that never answer end in the failed-read state", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    component = mount(PersonalDeploymentsPage, {
      target: document.body,
      props: { accountId: "blank-1", listDeployApps: () => new Promise(() => {}) } as never,
    });
    flushSync();
    expect(document.querySelector("[data-testid='deploy-skeleton']")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector("[data-testid='deploy-skeleton']")).toBeNull();
    expect(document.querySelector("[data-testid='deploy-load-error']")?.textContent).toContain("Couldn't read your deployments.");
    expect(document.querySelector("[data-testid='deploy-retry']")).toBeTruthy();
  });
});
