// @vitest-environment happy-dom

/** AUDIT-3c: a failed open never puts adapter text in the brain status line. */

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, ok } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

describe("BrainPage raw error text", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function mountWorkers() {
    const library = {
      getCompany: vi.fn(async () => ok({
        workers: [{
          id: "scout",
          name: "Scout",
          description: "Finds things",
          scope: "company",
          company: "indigo",
          path: "companies/indigo/workers/scout/worker.yaml",
          type: "worker",
          status: "active",
        }],
        skills: [],
      })),
    };
    const shell = {
      openClaudeCodeLink: vi.fn(async () => ok(undefined)),
      openInEditor: vi.fn(async () => failure("UPSTREAM_500", RAW)),
      openFileInClaude: vi.fn(async () => failure("UPSTREAM_500", RAW)),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "workers",
        slug: "indigo",
        files: null,
        library: library as never,
        shell: shell as never,
        settings: null,
      },
    });
  }

  function button(text: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
      | HTMLButtonElement
      | undefined;
  }

  it("a failed Edit shows plain copy and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountWorkers();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='worker-row']")).toBeTruthy());
    (document.querySelector("[data-testid='worker-row']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(button("Edit worker.yaml")).toBeTruthy());
    button("Edit worker.yaml")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='brain-status']")).toBeTruthy());
    flushSync();
    const status = document.querySelector("[data-testid='brain-status']")!;
    expect(status.textContent).toBe("Could not open the file. Try again.");
    expect(document.body.innerHTML).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[brain] open in editor failed", "UPSTREAM_500", RAW);
  });

  it("a failed Open in Claude Code shows plain copy and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountWorkers();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='worker-row']")).toBeTruthy());
    (document.querySelector("[data-testid='worker-row']") as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => expect(button("Open in Claude Code")).toBeTruthy());
    button("Open in Claude Code")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='brain-status']")).toBeTruthy());
    flushSync();
    const status = document.querySelector("[data-testid='brain-status']")!;
    expect(status.textContent).toBe("Could not open Claude Code. Try again.");
    expect(document.body.innerHTML).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[brain] open in Claude Code failed", "UPSTREAM_500", RAW);
  });
});
