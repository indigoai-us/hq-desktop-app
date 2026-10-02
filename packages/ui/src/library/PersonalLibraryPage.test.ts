// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import PersonalLibraryPage from "./PersonalLibraryPage.svelte";
import PersonalDeploymentsPage from "./PersonalDeploymentsPage.svelte";

describe("US-031 personal library and deployments", () => {
  let component: Record<string, unknown> | null = null;
  let host: HTMLDivElement;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
  });

  it("shows the selected shared file in the preview column", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalLibraryPage, { target: host, props: {} });
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="library-shared-tab"]')!.click();
    flushSync();
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="library-shared-row"]')];
    expect(rows.length).toBeGreaterThan(1);
    rows[1]!.click();
    flushSync();
    expect(host.querySelector('[data-testid="library-preview-name"]')?.textContent).toContain("dunning-reconcile");
    expect(host.querySelector('[data-testid="library-file-preview"]')?.textContent).toContain("dunning-reconcile");
    expect(host.querySelector('[data-testid="library-your-access"]')?.textContent).toContain("write");
  });

  it("shows deploy progress and keeps the previous build serving", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, { target: host, props: {} });
    flushSync();
    expect(host.querySelector('[data-testid="deploy-progress"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="deploy-redeploy"]')!.click();
    flushSync();
    const progress = host.querySelector('[data-testid="deploy-progress"]');
    expect(progress?.textContent).toContain("Deploying");
    expect(host.querySelector('[data-testid="deploy-live-until-swap"]')?.textContent).toContain("v4");
    expect(host.querySelector('[data-testid="deploy-redeploy"]')?.hasAttribute("disabled")).toBe(true);
  });
});
