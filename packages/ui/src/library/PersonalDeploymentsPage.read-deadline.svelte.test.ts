// @vitest-environment happy-dom

// BLANK-1: deployments reads that never answer must not hold the skeleton
// forever; after the shared read deadline the page shows the failed-read
// line and Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { expectPendingRead } from "../common/read-loader.test-support.js";
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

describe("PersonalDeploymentsPage pending read (BLANK-3)", () => {
  it("reads that never answer keep loading with a waiting line and Try again, never a failed state", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    component = mount(PersonalDeploymentsPage, {
      target: document.body,
      props: { accountId: "blank-1", listDeployApps: () => new Promise(() => {}) } as never,
    });
    flushSync();
    expect(document.querySelector("[data-testid='deploy-loader']")).toBeTruthy();
    await expectPendingRead(document, "deploy-loader");
  });
});
