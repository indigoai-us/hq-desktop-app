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
});
