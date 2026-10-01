// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
import CompanyGoalsPage from "./CompanyGoalsPage.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

describe("CompanyGoalsPage", () => {
  it("explains that an empty goals list reflects the company board", async () => {
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") {
        return { objectives: [], initiatives: [] };
      }
      if (command === "get_local_projects" || command === "get_company_project_creators") {
        return [];
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CompanyGoalsPage, {
      target: host,
      props: {
        adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter,
        slug: "indigo",
      },
    });
    flushSync();

    await expect.poll(() => host?.querySelector('[data-testid="empty-goals-state"]')).toBeTruthy();
    expect(host.textContent).toContain("No goals are set on this company's board yet.");
  });
});
