// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import { fakeProjectsApi } from "../projects/testing.js";

// QA-041: a picker that throws while rendering must stay inside its own boundary.
vi.mock("./LinkPicker.svelte", () => ({
  default: () => {
    throw new Error("picker render failed");
  },
}));

const { default: GoalsView } = await import("./GoalsView.svelte");

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

describe("GoalsView sheet boundary", () => {
  it("keeps the Goals page alive when the link picker throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ipc = async (command: string): Promise<unknown> => {
      if (command === "get_local_company_goals") return { objectives: [], initiatives: [] };
      if (command === "get_local_projects") return [];
      if (command === "get_company_project_creators") return [];
      throw new Error(`Unexpected IPC command: ${command}`);
    };
    host = document.createElement("div");
    document.body.append(host);
    component = mount(GoalsView, {
      target: host,
      props: { adapter: { projects: fakeProjectsApi(ipc) } as PlatformAdapter, slug: "getindigo" },
    });
    flushSync();
    await expect.poll(() => host?.querySelector("[data-testid='link-project']")).toBeTruthy();

    (host?.querySelector("[data-testid='link-project']") as HTMLButtonElement).click();
    flushSync();

    expect(host?.querySelector("[data-testid='link-picker-failed']")).toBeTruthy();
    expect(host?.querySelector("[data-testid='link-project']")).toBeTruthy();
    expect(errors).toHaveBeenCalledWith("[goals] link picker failed", expect.any(Error));
    errors.mockRestore();
  });
});
