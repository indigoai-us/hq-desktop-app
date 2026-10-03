// @vitest-environment happy-dom

/**
 * OWNER-R8: clicking an objective opens the side pane with its details and
 * linked projects; Add and Remove use the goals-cache link write, optimistic
 * with rollback. Response shapes mirror get_local_company_goals and
 * get_local_projects with placeholder data.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  localStorage.clear();
});

const CACHE_KEY = "hq-goals-cache:acme";

const objective = {
  id: "obj-1",
  title: "Objective One",
  description: "Placeholder description",
  status: "on_track",
  timeframe: "2026",
  owner: "Pat Example <pat@example.com>",
  keyResults: [{ id: "kr-1", title: "Key result one", current: 2, target: 4, unit: "items" }],
  initiativeIds: [],
};

function project(id: string, status = "active") {
  return {
    id,
    name: id,
    company: "acme",
    description: "",
    status,
    prdPath: `companies/acme/projects/${id}/prd.json`,
    storiesTotal: 4,
    storiesComplete: 1,
  };
}

type Links = { objectiveId: string; krKey: string; projectId: string; projectName: string }[];

function seed(links: Links): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ objectives: [objective], links }));
}

function storedLinks(): Links {
  return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}").links ?? [];
}

async function render(opts: {
  links?: Links;
  canEdit?: boolean;
  projects?: () => Promise<unknown>;
  onopenproject?: (id: string) => void;
} = {}) {
  seed(opts.links ?? []);
  const ipc = async (command: string): Promise<unknown> => {
    if (command === "get_local_company_goals") return { objectives: [objective], initiatives: [] };
    if (command === "get_local_projects") {
      return opts.projects ? opts.projects() : [project("proj-alpha"), project("proj-beta", "planned")];
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
      slug: "acme",
      canEdit: opts.canEdit ?? true,
      onopenproject: opts.onopenproject,
    },
  });
  flushSync();
  await expect.poll(() => host?.querySelector("[data-testid='goal-row']")).toBeTruthy();
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host?.querySelector(sel) as T | null;
}

function all(sel: string): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>(sel) ?? []);
}

const alphaLink = { objectiveId: "obj-1", krKey: "kr-1", projectId: "proj-alpha", projectName: "proj-alpha" };

describe("GoalsView objective pane (OWNER-R8)", () => {
  it("row click opens the pane with details; the row shows selected; close returns focus", async () => {
    await render({ links: [alphaLink] });
    expect(q("[data-testid='goal-pane']")).toBeNull();
    const row = q("[data-testid='goal-row']")!;
    row.click();
    flushSync();
    const pane = q("[data-testid='goal-pane']")!;
    expect(pane).toBeTruthy();
    expect(row.classList.contains("selected")).toBe(true);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(pane.textContent).toContain("Objective One");
    expect(q("[data-testid='goal-pane-meta']")?.textContent).toContain("on track");
    expect(q("[data-testid='goal-pane-owner']")?.textContent).toContain("Pat Example");
    expect(q("[data-testid='goal-pane-owner']")?.textContent).toContain("pat@example.com");
    expect(q("[data-testid='goal-pane-description']")?.textContent).toBe("Placeholder description");
    expect(pane.textContent).toContain("Key result one");
    expect(pane.textContent).toContain("50%");

    (q("[data-testid='goal-pane-close']") as HTMLButtonElement).click();
    flushSync();
    expect(q("[data-testid='goal-pane']")).toBeNull();
    expect(document.activeElement).toBe(q("[data-testid='goal-row']"));
  });

  it("Enter on a focused row opens the pane and Escape closes it", async () => {
    await render();
    const row = q("[data-testid='goal-row']")!;
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(q("[data-testid='goal-pane']")).toBeTruthy();
    q("[data-testid='goal-pane']")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(q("[data-testid='goal-pane']")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("lists linked projects with status and opens one in Projects", async () => {
    const onopenproject = vi.fn();
    await render({ links: [alphaLink], onopenproject });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    await expect.poll(() => q("[data-testid='goal-pane-project']")?.textContent).toContain("Live");
    const rows = all("[data-testid='goal-pane-project']");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("proj-alpha");
    (rows[0]!.querySelector(".lp-open") as HTMLButtonElement).click();
    expect(onopenproject).toHaveBeenCalledWith("proj-alpha");
  });

  it("Add opens the picker without already-linked projects and writes the link", async () => {
    await render({ links: [alphaLink] });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    await expect.poll(() => q("[data-testid='goal-pane-project']")?.textContent).toContain("Live");
    (q("[data-testid='goal-pane-add']") as HTMLButtonElement).click();
    flushSync();
    const picker = q("[data-testid='link-picker']")!;
    const names = Array.from(picker.querySelectorAll(".list")[0]!.querySelectorAll("button.row")).map((b) => b.textContent?.trim());
    expect(names).toEqual(["proj-beta"]);
    (picker.querySelectorAll(".list")[0]!.querySelector("button.row") as HTMLButtonElement).click();
    flushSync();
    (picker.querySelectorAll(".list")[1]!.querySelector("button.row") as HTMLButtonElement).click();
    flushSync();
    expect(q("[data-testid='link-picker']")).toBeNull();
    expect(storedLinks()).toEqual([
      alphaLink,
      { objectiveId: "obj-1", krKey: "kr-1", projectId: "proj-beta", projectName: "proj-beta" },
    ]);
    expect(all("[data-testid='goal-pane-project']").map((r) => r.querySelector(".lp-name")?.textContent)).toEqual([
      "proj-alpha",
      "proj-beta",
    ]);
  });

  it("Add rolls back and offers Try again when the write fails", async () => {
    await render({ links: [alphaLink] });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    await expect.poll(() => q("[data-testid='goal-pane-project']")?.textContent).toContain("Live");
    (q("[data-testid='goal-pane-add']") as HTMLButtonElement).click();
    flushSync();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const picker = q("[data-testid='link-picker']")!;
    (picker.querySelectorAll(".list")[0]!.querySelector("button.row") as HTMLButtonElement).click();
    flushSync();
    (picker.querySelectorAll(".list")[1]!.querySelector("button.row") as HTMLButtonElement).click();
    flushSync();
    expect(all("[data-testid='goal-pane-project']")).toHaveLength(1);
    expect(q("[data-testid='goal-pane-save-error']")?.textContent).toContain("Couldn't save the change.");
    expect(storedLinks()).toEqual([alphaLink]);

    vi.mocked(localStorage.setItem).mockRestore();
    (q("[data-testid='goal-pane-save-error'] button") as HTMLButtonElement).click();
    flushSync();
    expect(q("[data-testid='goal-pane-save-error']")).toBeNull();
    expect(storedLinks().map((l) => l.projectId)).toEqual(["proj-alpha", "proj-beta"]);
  });

  it("Remove drops the link and rolls back when the write fails", async () => {
    await render({ links: [alphaLink] });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    await expect.poll(() => q("[data-testid='goal-pane-project']")?.textContent).toContain("Live");

    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    (q("[data-testid='goal-pane-remove']") as HTMLButtonElement).click();
    flushSync();
    expect(all("[data-testid='goal-pane-project']")).toHaveLength(1);
    expect(q("[data-testid='goal-pane-save-error']")).toBeTruthy();
    expect(storedLinks()).toEqual([alphaLink]);

    vi.mocked(localStorage.setItem).mockRestore();
    (q("[data-testid='goal-pane-remove']") as HTMLButtonElement).click();
    flushSync();
    expect(all("[data-testid='goal-pane-project']")).toHaveLength(0);
    expect(storedLinks()).toEqual([]);
    expect(q("[data-testid='goal-pane-empty']")?.textContent).toBe("No linked projects yet.");
  });

  it("a read-only viewer sees no Add or Remove", async () => {
    await render({ links: [alphaLink], canEdit: false });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    await expect.poll(() => q("[data-testid='goal-pane-project']")?.textContent).toContain("Live");
    expect(q("[data-testid='goal-pane-add']")).toBeNull();
    expect(q("[data-testid='goal-pane-remove']")).toBeNull();
  });

  it("shows the empty line only after the projects read succeeds", async () => {
    let resolve: (value: unknown) => void = () => {};
    const pending = new Promise((r) => (resolve = r));
    await render({ projects: () => pending });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    expect(q("[data-testid='goal-pane-loader']")).toBeTruthy();
    expect(q("[data-testid='goal-pane-empty']")).toBeNull();
    resolve([project("proj-alpha")]);
    await expect.poll(() => q("[data-testid='goal-pane-empty']")?.textContent).toBe("No linked projects yet.");
    expect(q("[data-testid='goal-pane-loader']")).toBeNull();
  });

  it("a failed projects read shows the failed line with Try again, not the empty line", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render({ projects: () => Promise.reject(new Error("read failed")) });
    q("[data-testid='goal-row']")!.click();
    flushSync();
    await expect.poll(() => q("[data-testid='goal-pane-projects-error']")).toBeTruthy();
    expect(q("[data-testid='goal-pane-empty']")).toBeNull();
    expect(q("[data-testid='goal-pane-projects-error'] button")?.textContent).toBe("Try again");
  });
});
