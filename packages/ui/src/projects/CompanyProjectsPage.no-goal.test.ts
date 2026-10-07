// @vitest-environment happy-dom
// OWNER-D 9: unlinked projects moved from Goals to the Projects page, where the
// existing filter has a "No goal" choice.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
import CompanyProjectsPage from "./CompanyProjectsPage.svelte";
import { writeGoalsCache } from "../goals/goals-model.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

const ROOT = ["companies", "acme", "projects"].join("/");
const project = (id: string) => ({
  id,
  name: id,
  company: "acme",
  description: "",
  status: "active",
  prdPath: `${ROOT}/${id}/prd.json`,
  storiesTotal: 2,
  storiesComplete: 1,
});

describe("Projects 'No goal' filter (OWNER-D 9)", () => {
  it("shows only projects with no goal link", async () => {
    writeGoalsCache(localStorage, "acme", {
      objectives: [],
      links: [{ objectiveId: "o1", krKey: "k1", projectId: "linked-one", projectName: "linked-one" }],
    });
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_projects") return [project("linked-one"), project("loose-one")];
      if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
      return [];
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CompanyProjectsPage, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "acme" },
    });
    flushSync();
    await expect.poll(() => host?.textContent ?? "").toContain("loose-one");
    // The page's existing filter button cycles All, Active, No goal.
    const cycle = () =>
      [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^Filter:/.test(b.textContent?.trim() ?? ""))!;
    cycle().click();
    flushSync();
    cycle().click();
    flushSync();
    expect(cycle().textContent).toContain("No goal");
    await expect.poll(() => host?.textContent ?? "").not.toContain("linked-one");
    expect(host!.textContent).toContain("loose-one");
  });
});
