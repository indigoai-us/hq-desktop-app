// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
import CompanyProjectsPage from "./CompanyProjectsPage.svelte";

// AUDIT-3: a failed projects read shows plain copy and a Try again control.
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

describe("CompanyProjectsPage failed read (AUDIT-3)", () => {
  it("offers Try again and loads the projects on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_projects") {
        if (fail) throw new Error("get_local_projects: EACCES");
        return [{ id: "beta-launch", name: "beta-launch", company: "acme", description: "", status: "active", prdPath: "companies/acme/projects/beta-launch/prd.json", storiesTotal: 2, storiesComplete: 1 }];
      }
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
    await expect.poll(() => host?.querySelector("[data-testid='projects-load-error']")?.textContent ?? "").toContain("Couldn't read this company's projects.");
    expect(host?.textContent).not.toContain("EACCES");
    fail = false;
    (host?.querySelector("[data-testid='projects-retry']") as HTMLButtonElement).click();
    await expect.poll(() => host?.querySelector("[data-testid='projects-load-error']")).toBeNull();
    await expect.poll(() => host?.textContent ?? "").toContain("beta-launch");
  });
});
