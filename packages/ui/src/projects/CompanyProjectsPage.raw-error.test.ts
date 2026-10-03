// @vitest-environment happy-dom

/** AUDIT-3c: a failed story or task read never shows transport text. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "./testing.js";
import CompanyProjectsPage from "./CompanyProjectsPage.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

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

function mountPage() {
  const ipc = async (command: string): Promise<unknown> => {
    if (command === "get_local_projects") {
      return [{ id: "beta-launch", name: "beta-launch", company: "acme", description: "", status: "active", prdPath: "companies/acme/projects/beta-launch/prd.json", storiesTotal: 2, storiesComplete: 1 }];
    }
    if (command === "get_local_project_prd") throw new Error(RAW);
    if (command === "get_local_project_readme") return "";
    if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
    return [];
  };
  host = document.createElement("div");
  document.body.append(host);
  component = mount(CompanyProjectsPage, {
    target: host,
    props: {
      adapter: {
        projects: fakeProjectsApi(ipc),
        settings: { getConfig: async () => ({ ok: true, value: {} }) },
        workMesh: { getProjectView: async () => ({ ok: false, reason: "unavailable", message: "" }) },
        isAvailable: () => false,
      } as unknown as PlatformAdapter,
      slug: "acme",
    },
  });
  flushSync();
}

function warnedRaw(warn: ReturnType<typeof vi.spyOn>, tag: string): boolean {
  return warn.mock.calls.some(
    (args) => args[0] === tag && args.slice(1).some((a) => String(a instanceof Error ? a.message : a).includes("HTTP 500")),
  );
}

describe("CompanyProjectsPage raw error text (AUDIT-3c)", () => {
  it("a failed story read shows plain copy and logs the raw text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountPage();
    await expect.poll(() => host?.querySelector("[data-testid='view-toggle-list']")).toBeTruthy();
    (host!.querySelector("[data-testid='view-toggle-list']") as HTMLButtonElement).click();
    await expect.poll(() => host?.querySelector("[data-testid='project-row']")).toBeTruthy();
    (host!.querySelector("[data-testid='project-row']") as HTMLElement).click();
    await expect.poll(() => host?.querySelector("[data-testid='tab-board']")).toBeTruthy();
    (host!.querySelector("[data-testid='tab-board']") as HTMLElement).click();
    await expect.poll(() => host?.textContent ?? "").toContain("Could not load this project’s stories. Try again.");
    expect(host!.innerHTML).not.toContain("HTTP 500");
    expect(warnedRaw(warn, "[projects] story load failed")).toBe(true);
  });

  it("a failed task read shows plain copy and logs the raw text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountPage();
    await expect.poll(() => host?.querySelector("[data-testid='portfolio-kanban'] [data-testid='project-row']")).toBeTruthy();
    (host!.querySelector("[data-testid='portfolio-kanban'] [data-testid='project-row'] .project-open") as HTMLElement).click();
    await expect.poll(() => host?.textContent ?? "", { timeout: 3000 }).toContain("Could not load this project’s tasks. Try again.");
    expect(host!.innerHTML).not.toContain("HTTP 500");
    expect(warnedRaw(warn, "[projects] task load failed")).toBe(true);
  });
});
