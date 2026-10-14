// @vitest-environment happy-dom
// OWNER-R34: Deployments filters are two header pills (Status, Scope) plus a
// "Deployed by you" toggle; the side rail is gone. Pills combine, the count
// follows the filter, state survives leaving and coming back, and a sleeping
// app (hq-deploy computeStatus) is not counted as active.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import PersonalDeploymentsPage, { resetDeployPillsForTests } from "./PersonalDeploymentsPage.svelte";
import { deployAppsFixture } from "./personal-deployments.fixture.js";
import { deploymentFromApp } from "./personal-deployments.js";
import { chooseDropdown, dropdownValue } from "../test-support/dropdown.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  resetDeployPillsForTests();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".table .drow:not(.hd)")];

async function mountPage(): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PersonalDeploymentsPage, {
    target: host,
    props: {
      accountId: "r34",
      companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
      listDeployApps: async (scope: string) => ({ ok: true, value: deployAppsFixture(scope) as never }),
    } as never,
  });
  await settle();
  return host;
}

describe("Deployments filter pills (OWNER-R34)", () => {
  it("has no side rail; two pills and a by-you toggle sit in the header", async () => {
    const root = await mountPage();
    expect(root.querySelector('aside[aria-label="Deployments"]')).toBeNull();
    expect(await dropdownValue(root, "deploy-status-pill")).toBe("all");
    expect(await dropdownValue(root, "deploy-scope-pill")).toBe("all");
    expect(root.querySelector('[data-testid="deploy-by-you"]')?.textContent).toBe("Deployed by you");
    expect(root.querySelector('[data-testid="deploy-clear-filters"]')).toBeNull();
  });

  it("status and scope combine; the count follows; Clear resets", async () => {
    const root = await mountPage();
    expect(rows(root)).toHaveLength(6);
    await chooseDropdown(root, "deploy-scope-pill", "company");
    expect(rows(root)).toHaveLength(3);
    await chooseDropdown(root, "deploy-status-pill", "active");
    const shown = rows(root).length;
    expect(shown).toBeLessThan(3);
    expect(root.querySelector('[data-testid="deploy-count"]')?.textContent).toBe(`${shown} of 6 apps`);
    root.querySelector<HTMLButtonElement>('[data-testid="deploy-clear-filters"]')!.click();
    flushSync();
    expect(rows(root)).toHaveLength(6);
    expect(root.querySelector('[data-testid="deploy-count"]')?.textContent).toBe("6 apps");
  });

  it("keeps the filter when the page is left and opened again", async () => {
    let root = await mountPage();
    await chooseDropdown(root, "deploy-scope-pill", "personal");
    if (component) await unmount(component);
    component = null;
    root.remove();
    root = await mountPage();
    expect(await dropdownValue(root, "deploy-scope-pill")).toBe("personal");
    expect(rows(root)).toHaveLength(3);
  });

  it("a sleeping app (computeStatus) is Sleeping, not active", () => {
    const scope = { id: "personal", kind: "personal", label: "Personal", mark: "P" } as never;
    const row = deploymentFromApp({ id: "a", subdomain: "a", status: "active", computeStatus: "sleeping" }, scope, null, Date.now());
    expect(row?.status).toBe("sleeping");
  });
});
