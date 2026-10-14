// @vitest-environment happy-dom
// BLANK-3: the project list is the board's primary read; a slow goals read
// must not hold it. The board shows the projects as soon as they answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
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

describe("CompanyProjectsPage projects first (BLANK-3)", () => {
  it("shows the projects while the goals read is still pending", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_projects") {
        return [{ id: "beta-launch", name: "beta-launch", company: "acme", description: "", status: "active", prdPath: "companies/acme/projects/beta-launch/prd.json", storiesTotal: 2, storiesComplete: 1 }];
      }
      if (command === "get_local_company_goals") return new Promise(() => {});
      return [];
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CompanyProjectsPage, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "acme" },
    });
    flushSync();
    await expect.poll(() => host?.textContent ?? "").toContain("beta-launch");
    expect(host?.querySelector("[data-testid='projects-loader']")).toBeNull();
  });
});
