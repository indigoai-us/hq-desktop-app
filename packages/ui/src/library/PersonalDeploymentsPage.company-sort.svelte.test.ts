// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import PersonalDeploymentsPage, { resetDeployPillsForTests } from "./PersonalDeploymentsPage.svelte";
import { deployAppsFixture } from "./personal-deployments.fixture.js";
import { chooseDropdown, dropdownOptions, dropdownValue } from "../test-support/dropdown.js";

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

function rows(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(".table .drow:not(.hd)")];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mountPage(): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PersonalDeploymentsPage, {
    target: host,
    props: {
      accountId: "company-sort",
      companies: [
        { slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" },
        { slug: "acme", displayName: "Acme", kind: "company", state: "cloud" },
      ] as never,
      listDeployApps: async (scope: string) => ({ ok: true, value: (scope === "acme" ? { apps: [] } : deployAppsFixture(scope)) as never }),
    } as never,
  });
  await settle();
  return host;
}

describe("Deployments company filter and sorting", () => {
  it("lists loaded scopes only and composes a company filter with the existing filters", async () => {
    const root = await mountPage();
    await dropdownValue(root, "deploy-company-pill");
    const options = await dropdownOptions(root, "deploy-company-pill");
    expect(options.map((option) => option.label)).toEqual(["All companies", "Indigo", "Personal"]);
    await chooseDropdown(root, "deploy-company-pill", "indigo");
    await chooseDropdown(root, "deploy-status-pill", "active");
    root.querySelector<HTMLInputElement>("input.search")!.value = "standup";
    root.querySelector<HTMLInputElement>("input.search")!.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(rows(root)).toHaveLength(1);
    expect(rows(root)[0]?.textContent).toContain("Indigo");
  });

  it("sorts each header in both directions, returns to default, and keeps missing values last", async () => {
    const root = await mountPage();
    expect(root.querySelector(".table")?.getAttribute("role")).toBe("table");
    const initial = rows(root).map((row) => row.textContent);
    for (const [key, first, second] of [
      ["app", "ascending", "descending"],
      ["scope", "ascending", "descending"],
      ["status", "ascending", "descending"],
      ["access", "ascending", "descending"],
      ["views", "ascending", "descending"],
      ["lastVisit", "descending", "ascending"],
    ] as const) {
      const header = root.querySelector<HTMLButtonElement>(`[data-testid='deploy-sort-${key}']`)!;
      header.click();
      flushSync();
      expect(header.parentElement?.getAttribute("aria-sort")).toBe(first);
      if (key === "views" || key === "lastVisit") expect(rows(root).at(-1)?.textContent).toContain("—");
      header.click();
      flushSync();
      expect(header.parentElement?.getAttribute("aria-sort")).toBe(second);
      if (key === "views" || key === "lastVisit") expect(rows(root).at(-1)?.textContent).toContain("—");
      header.click();
      flushSync();
      expect(header.parentElement?.getAttribute("aria-sort")).toBe("none");
      expect(rows(root).map((row) => row.textContent)).toEqual(initial);
    }
  });

  it("keeps company and sort state through a remount, keeps a visible selection, and clears a hidden one", async () => {
    let root = await mountPage();
    const chosen = rows(root).find((row) => row.textContent?.includes("indigo-standup-report"))!;
    chosen.click();
    const appHeader = [...root.querySelectorAll<HTMLButtonElement>(".sort-header")].find((button) => button.textContent?.includes("App"))!;
    appHeader.click();
    flushSync();
    await chooseDropdown(root, "deploy-company-pill", "indigo");
    if (component) await unmount(component);
    component = null;
    root.remove();
    root = await mountPage();
    expect(root.querySelector(".sort-header")?.parentElement?.getAttribute("aria-sort")).toBe("ascending");
    expect(await dropdownValue(root, "deploy-company-pill")).toBe("indigo");
    const remountedChoice = rows(root).find((row) => row.textContent?.includes("indigo-standup-report"))!;
    remountedChoice.click();
    flushSync();
    expect(root.querySelector("[aria-current='true']")?.textContent).toContain("indigo-standup-report");
    await chooseDropdown(root, "deploy-status-pill", "active");
    expect(root.querySelector("[aria-current='true']")?.textContent).toContain("indigo-standup-report");
    await chooseDropdown(root, "deploy-company-pill", "personal");
    expect(root.querySelector("[aria-current='true']")).toBeNull();
    expect(root.querySelector("[data-testid='deploy-inspector']")).toBeNull();
    expect(await dropdownValue(root, "deploy-company-pill")).toBe("personal");
  });

  it("resets the company pill only after a completed refresh removes that company's rows", async () => {
    let root = await mountPage();
    await chooseDropdown(root, "deploy-company-pill", "indigo");
    localStorage.clear();
    if (component) await unmount(component);
    component = null;
    root.remove();
    const personal = deferred<{ apps: never[] }>();
    const indigo = deferred<{ apps: never[] }>();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, {
      target: host,
      props: {
        accountId: "company-sort",
        companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
        listDeployApps: async (scope: string) => ({ ok: true, value: await (scope === "personal" ? personal.promise : indigo.promise) as never }),
      } as never,
    });
    await settle();
    expect(await dropdownValue(host, "deploy-company-pill")).toBe("indigo");
    personal.resolve({ apps: [] });
    indigo.resolve({ apps: [] });
    await settle();
    expect(await dropdownValue(host, "deploy-company-pill")).toBe("all");
  });

  it("keeps the company pill when that scope failed to load", async () => {
    let root = await mountPage();
    await chooseDropdown(root, "deploy-company-pill", "indigo");
    localStorage.clear();
    if (component) await unmount(component);
    component = null;
    root.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, {
      target: host,
      props: {
        accountId: "company-sort",
        companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
        listDeployApps: async (scope: string) => {
          if (scope === "indigo") throw new Error("offline");
          return { ok: true, value: { apps: [] } as never };
        },
      } as never,
    });
    await settle();
    expect(await dropdownValue(host, "deploy-company-pill")).toBe("indigo");
  });
});
