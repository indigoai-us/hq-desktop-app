// @vitest-environment happy-dom

// QA-091: on Deployments, the empty-state "Clear search" button cleared the
// query and also reset the scope filter to All. It must clear only the query,
// so a Personal scope + no-match search comes back to the Personal set.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

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
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function subdomains(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(".table .drow:not(.hd)")].map(
    (row) => row.textContent ?? "",
  );
}

describe("PersonalDeploymentsPage empty-state Clear search (QA-091)", () => {
  it("clears only the query and keeps the Personal scope selected", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, {
      target: host,
      props: {
        accountId: "qa-091",
        companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
        listDeployApps: async (scope: string) => ({ ok: true, value: deployAppsFixture(scope) as never }),
      } as never,
    });
    await settle();
    expect(subdomains(host)).toHaveLength(6);

    const personal = [...host.querySelectorAll<HTMLButtonElement>("aside .row")].find(
      (b) => b.textContent?.trim() === "Personal",
    )!;
    personal.click();
    flushSync();
    expect(subdomains(host)).toHaveLength(3);

    const search = host.querySelector<HTMLInputElement>("input.search")!;
    search.value = "zzz-no-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const clear = host.querySelector<HTMLButtonElement>('[data-testid="personal-deploy-empty-clear"]')!;
    expect(clear.textContent?.trim()).toBe("Clear search");

    clear.click();
    flushSync();

    expect(search.value).toBe("");
    expect(personal.getAttribute("aria-current")).toBe("true");
    const rows = subdomains(host);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toContain("Personal");
    expect(host.querySelector('[data-testid="deploy-count"]')?.textContent).toBe("3 of 6 apps");
  });
});
