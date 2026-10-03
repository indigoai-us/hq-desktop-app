// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "../projects/testing.js";
import GoalsView from "./GoalsView.svelte";

// AUDIT-3: a failed goals read never paints the transport message, offers
// Try again, and does not also claim the board is empty.
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

describe("GoalsView failed read (AUDIT-3)", () => {
  it("shows plain copy and Try again, then recovers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") {
        if (fail) throw new Error("hq_pro_fetch 502: upstream timeout at /v1/goals");
        return {
          objectives: [{ id: "o1", title: "Ship the beta", description: "", status: "on_track", timeframe: "2026", owner: "", keyResults: [], initiativeIds: [] }],
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
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "acme" },
    });
    flushSync();
    const errorBox = () => host?.querySelector("[data-testid='goals-load-error']");
    await expect.poll(() => errorBox()?.textContent ?? "").toContain("Couldn't read this company's goals.");
    expect(host?.textContent).not.toContain("502");
    expect(host?.textContent).not.toContain("/v1/goals");
    expect(host?.querySelector("[data-testid='empty-goals-state']")).toBeNull();

    fail = false;
    (host?.querySelector("[data-testid='goals-retry']") as HTMLButtonElement).click();
    await expect.poll(() => host?.textContent ?? "").toContain("Ship the beta");
    expect(errorBox()).toBeNull();
  });
});

describe("GoalsView first load (AUDIT-3)", () => {
  it("holds the skeleton until the board answers, never flashing the empty line", async () => {
    let release: (() => void) | null = null;
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") {
        await new Promise<void>((resolve) => (release = resolve));
        return { objectives: [{ id: "o1", title: "Ship the beta", description: "", status: "on_track", timeframe: "2026", owner: "", keyResults: [], initiativeIds: [] }], initiatives: [] };
      }
      return [];
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "fresh-co" },
    });
    flushSync();
    await expect.poll(() => release !== null).toBe(true);
    expect(host.querySelector("[data-testid='goals-skeleton']")).not.toBeNull();
    expect(host.querySelector("[data-testid='empty-goals-state']")).toBeNull();
    release!();
    await expect.poll(() => host?.textContent ?? "").toContain("Ship the beta");
    expect(host.querySelector("[data-testid='goals-skeleton']")).toBeNull();
  });
});
