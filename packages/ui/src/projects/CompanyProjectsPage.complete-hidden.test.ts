// @vitest-environment happy-dom
// Complete projects are hidden by default on Board and List. A "Show N
// complete" control brings them back, the choice is saved on this machine,
// and the state filter set to Complete always shows them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
import { SHOW_COMPLETE_STORAGE_KEY } from "./projects-model.js";
import CompanyProjectsPage from "./CompanyProjectsPage.svelte";

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

const PROJECTS = [
  { id: "open-one", title: "Open one", company: "acme", description: "", status: "in_progress", prdPath: "companies/acme/projects/open-one/prd.json", storyCount: 4, storiesComplete: 1, repos: ["hq-desktop-app"], branchName: "feature/open" },
  { id: "done-one", title: "Done one", company: "acme", description: "", status: "completed", prdPath: "companies/acme/projects/done-one/prd.json", storyCount: 3, storiesComplete: 3 },
  { id: "done-two", title: "Done two", company: "acme", description: "", status: "completed", prdPath: "companies/acme/projects/done-two/prd.json", storyCount: 2, storiesComplete: 2 },
];

async function mountPage(): Promise<HTMLDivElement> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const ipc = async (command: string): Promise<unknown> => {
    if (command === "get_local_projects") return PROJECTS;
    return [];
  };
  host = document.createElement("div");
  document.body.append(host);
  component = mount(CompanyProjectsPage, {
    target: host,
    props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "acme" },
  });
  flushSync();
  await expect.poll(() => host?.textContent ?? "").toContain("Open one");
  return host;
}

const q = (el: HTMLElement, sel: string) => el.querySelector<HTMLElement>(sel);

describe("CompanyProjectsPage hides Complete by default", () => {
  it("board leaves the Complete column out and offers Show N complete", async () => {
    const el = await mountPage();
    expect(q(el, '[data-testid="portfolio-column-complete"]')).toBeNull();
    expect(el.textContent).not.toContain("Done one");
    expect(q(el, '[data-testid="show-complete"]')?.textContent).toBe("Show 2 complete");
  });

  it("Show N complete brings the column back and saves the choice", async () => {
    const el = await mountPage();
    q(el, '[data-testid="show-complete"]')?.click();
    flushSync();
    expect(q(el, '[data-testid="portfolio-column-complete"]')).not.toBeNull();
    expect(el.textContent).toContain("Done one");
    expect(localStorage.getItem(SHOW_COMPLETE_STORAGE_KEY)).toBe("1");

    q(el, '[data-testid="hide-complete"]')?.click();
    flushSync();
    expect(q(el, '[data-testid="portfolio-column-complete"]')).toBeNull();
    expect(localStorage.getItem(SHOW_COMPLETE_STORAGE_KEY)).toBe("0");
  });

  it("a saved choice to show Complete is honored on the next visit", async () => {
    localStorage.setItem(SHOW_COMPLETE_STORAGE_KEY, "1");
    const el = await mountPage();
    expect(q(el, '[data-testid="portfolio-column-complete"]')).not.toBeNull();
    expect(q(el, '[data-testid="show-complete"]')).toBeNull();
  });

  it("list view hides the Complete group the same way", async () => {
    const el = await mountPage();
    q(el, '[data-testid="view-toggle-list"]')?.click();
    flushSync();
    expect(q(el, '[data-testid="project-group-complete"]')).toBeNull();
    expect(q(el, '[data-testid="project-group-in-progress"]')).not.toBeNull();
    q(el, '[data-testid="show-complete"]')?.click();
    flushSync();
    expect(q(el, '[data-testid="project-group-complete"]')).not.toBeNull();
  });

  it("cards show repo chips, the branch and a stories line", async () => {
    const el = await mountPage();
    const card = [...el.querySelectorAll<HTMLElement>('[data-testid="project-row"]')].find((c) =>
      c.textContent?.includes("Open one"),
    )!;
    expect(q(card, '[data-testid="project-repo-chips"]')?.textContent).toContain("hq-desktop-app");
    expect(q(card, '[data-testid="project-branch"]')?.textContent).toContain("feature/open");
    expect(q(card, '[data-testid="project-stories"]')?.textContent).toBe("1 of 4 stories");
    expect(q(card, '[data-testid="project-state-dot"]')?.dataset.column).toBe("in-progress");
  });
});
