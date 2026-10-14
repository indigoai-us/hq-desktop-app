// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
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
});

describe("GoalsView", () => {
  it("reads board objectives and opens LinkPicker from Link project and New objective", async () => {
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") {
        return {
          objectives: [
            {
              id: "desk",
              title: "Desktop Experience",
              description: "",
              status: "on_track",
              timeframe: "2026",
              owner: "Corey",
              keyResults: [{ id: "kr1", title: "Ship the rail", current: 1, target: 9, unit: "stories" }],
              initiativeIds: [],
            },
          ],
          initiatives: [],
        };
      }
      if (command === "get_local_projects") {
        return [
          {
            id: "hq-desktop-app",
            name: "hq-desktop-app",
            company: "indigo",
            description: "",
            status: "active",
            prdPath: "companies/indigo/projects/hq-desktop-app/prd.json",
            storiesTotal: 9,
            storiesComplete: 1,
          },
        ];
      }
      if (command === "get_company_project_creators") return [];
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: {
        adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter,
        slug: "indigo",
      },
    });
    flushSync();
    await expect.poll(() => host?.textContent).toContain("Desktop Experience");
    expect(host?.textContent).toContain("11%");

    const link = host?.querySelector("[data-testid='link-project']") as HTMLButtonElement;
    link.click();
    flushSync();
    expect(host?.querySelector("[data-testid='link-picker']")).toBeTruthy();

    const close = host?.querySelector("[aria-label='Close']") as HTMLButtonElement;
    close.click();
    flushSync();

    const create = host?.querySelector("[data-testid='new-objective']") as HTMLButtonElement;
    create.click();
    flushSync();
    expect(host?.querySelector("[data-testid='new-goal-sheet']")).toBeTruthy();
    const nested = host?.querySelector("[data-testid='new-goal-link']") as HTMLButtonElement;
    nested.click();
    flushSync();
    expect(host?.querySelector("[data-testid='link-picker']")).toBeTruthy();
  });

  it("QA-041: Link project on a company with zero projects opens an empty picker instead of crashing", async () => {
    const other = (company: string) => ({
      id: "shared-id",
      name: "shared-id",
      company,
      description: "",
      status: "active",
      prdPath: `companies/${company}/projects/shared-id/prd.json`,
      storiesTotal: 1,
      storiesComplete: 0,
    });
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
      // Other companies own projects with the same id; the active company owns none.
      if (command === "get_local_projects") return [other("amass"), other("indigo")];
      if (command === "get_company_project_creators") return [];
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: {
        adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter,
        slug: "getindigo",
      },
    });
    flushSync();
    await expect.poll(() => host?.querySelector("[data-testid='link-project']")).toBeTruthy();
    await expect.poll(() => host?.querySelector("[data-testid='goals-loader']")).toBeNull();

    (host?.querySelector("[data-testid='link-project']") as HTMLButtonElement).click();
    flushSync();
    const picker = host?.querySelector("[data-testid='link-picker']");
    expect(picker).toBeTruthy();
    expect(picker?.textContent).toContain("No projects in this company yet.");
    expect(picker?.textContent).not.toContain("shared-id");
  });

  it("QA-041: the picker tolerates duplicate project ids within a company", async () => {
    const dup = (prdPath: string) => ({
      id: "dup",
      name: "dup",
      company: "indigo",
      description: "",
      status: "active",
      prdPath,
      storiesTotal: 1,
      storiesComplete: 0,
    });
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
      if (command === "get_local_projects") {
        return [dup("companies/indigo/projects/a/prd.json"), dup("companies/indigo/projects/b/prd.json")];
      }
      if (command === "get_company_project_creators") return [];
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "indigo" },
    });
    flushSync();
    await expect.poll(() => host?.querySelector("[data-testid='goals-loader']")).toBeNull();
    (host?.querySelector("[data-testid='link-project']") as HTMLButtonElement).click();
    flushSync();
    await expect.poll(() => host?.querySelectorAll("[data-testid='link-picker'] .row").length).toBe(2);
  });

  it("QA-071: a draft objective with one key result and one linked project saves with the link", async () => {
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
      if (command === "get_local_projects") {
        return [
          {
            id: "hq-desktop-app",
            name: "hq-desktop-app",
            company: "indigo",
            description: "",
            status: "active",
            prdPath: "companies/indigo/projects/hq-desktop-app/prd.json",
            storiesTotal: 9,
            storiesComplete: 1,
          },
        ];
      }
      if (command === "get_company_project_creators") return [];
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "indigo" },
    });
    flushSync();
    await expect.poll(() => host?.querySelector("[data-testid='goals-loader']")).toBeNull();
    // OWNER-D 9: Goals shows only goals and their linked projects; the
    // unlinked list lives on the Projects page filter.
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(host?.textContent).not.toContain("Unlinked projects");

    (host?.querySelector("[data-testid='new-objective']") as HTMLButtonElement).click();
    flushSync();
    const sheet = host!.querySelector("[role='dialog'][aria-label='New objective']") as HTMLElement;
    const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
    };
    type(sheet.querySelector("textarea")!, "Grow the desktop app");
    type(sheet.querySelector("input[placeholder='Key result']")!, "Ship the rail");
    (sheet.querySelector("[data-testid='new-goal-link']") as HTMLButtonElement).click();
    flushSync();

    const picker = host!.querySelector("[data-testid='link-picker']") as HTMLElement;
    expect(picker.textContent).not.toContain("Add an objective before linking");
    const rows = [...picker.querySelectorAll<HTMLButtonElement>(".row")];
    rows.find((row) => row.textContent?.includes("hq-desktop-app"))!.click();
    flushSync();
    const krRow = rows.find((row) => row.textContent?.includes("Ship the rail")) ??
      [...picker.querySelectorAll<HTMLButtonElement>(".row")].find((row) => row.textContent?.includes("Ship the rail"))!;
    expect(krRow.disabled).toBe(false);
    krRow.click();
    flushSync();
    expect(host?.querySelector("[data-testid='link-picker']")).toBeNull();
    expect(sheet.querySelector("[data-testid='new-goal-linked']")?.textContent).toContain("hq-desktop-app");

    [...sheet.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Create objective")!.click();
    flushSync();

    expect(host?.querySelector("[data-testid='new-goal-sheet']")).toBeNull();
    const objective = [...host!.querySelectorAll("article.obj")].find((el) => el.textContent?.includes("Grow the desktop app"));
    expect(objective?.textContent).toContain("Ship the rail");
    expect(objective?.querySelector(".km .chip")?.textContent).toBe("hq-desktop-app");
    expect(host?.textContent).not.toContain("Unlinked projects");
  });

  describe("QA-078: Link project on an existing objective", () => {
    const project = {
      id: "band-website",
      name: "Band Website",
      company: "indigo",
      description: "",
      status: "active",
      prdPath: "companies/indigo/projects/band-website/prd.json",
      storiesTotal: 1,
      storiesComplete: 1,
    };
    const mountWith = (keyResults: unknown[], projectsResult: () => Promise<unknown>) => {
      const ipc = async (command: string): Promise<unknown> => {
        if (command === "get_local_company_goals") {
          return {
            objectives: [
              { id: "launch", title: "Band Launch", description: "", status: "", timeframe: "2026", keyResults, initiativeIds: [] },
            ],
            initiatives: [],
          };
        }
        if (command === "get_local_projects") return projectsResult();
        if (command === "get_company_project_creators") return [];
        throw new Error(`Unexpected IPC command: ${command}`);
      };
      host = document.createElement("div");
      document.body.append(host);
      component = mount(GoalsView, {
        target: host,
        props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "indigo" },
      });
      flushSync();
    };
    const openPicker = async () => {
      await expect.poll(() => host?.textContent).toContain("Band Launch");
      (host?.querySelector("[data-testid='link-project']") as HTMLButtonElement).click();
      flushSync();
    };

    it("with no key results, explains the next step and opens the key-result form", async () => {
      mountWith([], async () => [project]);
      await openPicker();
      const picker = () => host?.querySelector("[data-testid='link-picker']");
      await expect.poll(() => picker()?.textContent).toContain("band-website");
      const needs = picker()?.querySelector("[data-testid='link-picker-needs-kr']");
      expect(needs?.textContent).toContain("Add a key result to this objective first");
      (needs?.querySelector("button") as HTMLButtonElement).click();
      flushSync();
      const form = host?.querySelector("[data-testid='add-kr-form']") as HTMLFormElement;
      expect(form).toBeTruthy();
      const input = form.querySelector("input") as HTMLInputElement;
      input.value = "Sell 100 tickets";
      input.dispatchEvent(new Event("input"));
      flushSync();
      form.requestSubmit();
      flushSync();
      expect(host?.querySelector("[data-testid='add-kr-form']")).toBeNull();
      const rows = [...(picker()?.querySelectorAll(".row") ?? [])].map((row) => row.textContent);
      expect(rows.some((text) => text?.includes("Sell 100 tickets"))).toBe(true);
    });

    it("with one key result and one project, shows both rows", async () => {
      mountWith([{ id: "kr1", title: "Sell 100 tickets", current: 0, target: 100 }], async () => [project]);
      await openPicker();
      const picker = () => host?.querySelector("[data-testid='link-picker']");
      await expect.poll(() => picker()?.querySelectorAll(".row").length).toBe(2);
      expect(picker()?.textContent).toContain("band-website");
      expect(picker()?.textContent).toContain("Sell 100 tickets");
      expect(picker()?.querySelector("[data-testid='link-picker-needs-kr']")).toBeNull();
    });

    it("shows an error with Try again when projects cannot be read", async () => {
      let fail = true;
      mountWith([{ id: "kr1", title: "Sell 100 tickets" }], async () => {
        if (fail) throw new Error("boom");
        return [project];
      });
      await openPicker();
      const picker = () => host?.querySelector("[data-testid='link-picker']");
      await expect.poll(() => picker()?.querySelector("[data-testid='link-picker-error']")?.textContent).toContain("Projects could not be loaded.");
      fail = false;
      (picker()?.querySelector("[data-testid='link-picker-error'] button") as HTMLButtonElement).click();
      await expect.poll(() => picker()?.textContent).toContain("band-website");
    });
  });
});

describe("GoalsView period empty state (QA-067)", () => {
  it("says no goals match the period instead of claiming the board is empty", async () => {
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") {
        return {
          objectives: [
            { id: "band", title: "Band Launch", description: "", status: "on_track", timeframe: "2026 H1", owner: "", keyResults: [], initiativeIds: [] },
          ],
          initiatives: [],
        };
      }
      if (command === "get_local_projects") return [];
      if (command === "get_company_project_creators") return [];
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "golden-thread" },
    });
    flushSync();
    await expect.poll(() => host?.textContent).toContain("Band Launch");
    const tab = [...host!.querySelectorAll<HTMLButtonElement>("[role='tab']")].find((b) => b.textContent === "H2")!;
    tab.click();
    flushSync();
    expect(host?.querySelector("[data-testid='empty-goals-state']")).toBeNull();
    expect(host?.querySelector("[data-testid='empty-period-state']")?.textContent).toBe(
      "No goals match H2. Choose All time to see all 1 objective.",
    );
  });
});
