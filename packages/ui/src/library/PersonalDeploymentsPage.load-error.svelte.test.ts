// @vitest-environment happy-dom

// AUDIT-3-17: when every deployments read fails, the page shows the plain
// failed-read line and Try again, never "No deployments yet."

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import PersonalDeploymentsPage from "./PersonalDeploymentsPage.svelte";
import { deployAppsFixture } from "./personal-deployments.fixture.js";

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

describe("PersonalDeploymentsPage failed read (AUDIT-3-17)", () => {
  it("shows Try again instead of the empty line and loads on retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, {
      target: host,
      props: {
        accountId: "audit-3-17",
        listDeployApps: async (scope: string) =>
          fail
            ? { ok: false, reason: "HTTP 502 Bad Gateway" }
            : { ok: true, value: deployAppsFixture(scope) as never },
      } as never,
    });
    flushSync();
    await expect.poll(() => host?.querySelector("[data-testid='deploy-load-error']")?.textContent ?? "").toContain("Couldn't read your deployments.");
    expect(host.textContent).not.toContain("No deployments yet.");
    expect(host.textContent).not.toContain("502");
    fail = false;
    (host.querySelector("[data-testid='deploy-retry']") as HTMLButtonElement).click();
    await expect.poll(() => host?.querySelectorAll("[data-testid='deploy-row']").length ?? 0).toBeGreaterThan(0);
    expect(host.querySelector("[data-testid='deploy-load-error']")).toBeNull();
  });
});
