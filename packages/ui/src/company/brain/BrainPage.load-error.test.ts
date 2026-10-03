// @vitest-environment happy-dom

// AUDIT-3-17: a failed Policies or Skills read shows the failed-read line and
// Try again, never the true-empty "No policies yet." line.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, unavailable } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("BrainPage failed read (AUDIT-3-17)", () => {
  it("a failed policies read is not shown as an empty company", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const files = {
      listDir: vi.fn(async () => (fail ? unavailable("HTTP 500 Internal Server Error") : ok([]))),
      getFileContent: vi.fn(async () => ok("")),
    };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "policies", slug: "audit-3-17-policies", files: files as never, library: null, shell: null, settings: null },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector("[data-testid='brain-read-error']")?.textContent).toContain("Some company files could not be read.");
    });
    expect(document.body.textContent).not.toContain("No policies yet.");
    expect(document.body.textContent).not.toContain("500");
    fail = false;
    (document.querySelector("[data-testid='brain-retry']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector("[data-testid='brain-read-error']")).toBeNull();
      expect(document.body.textContent).toContain("No policies yet.");
    });
  });

  it("a failed skills read is not shown as an empty company", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const library = { getCompany: vi.fn(async () => unavailable("io")) };
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "skills", slug: "audit-3-17-skills", files: null, library: library as never, shell: null, settings: null },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector("[data-testid='brain-retry']")).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain("No skills yet.");
  });
});
