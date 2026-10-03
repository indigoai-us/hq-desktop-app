// @vitest-environment happy-dom
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";

// BLANK-3 regression (CI 37149557808, company:workers under slow reads): the
// library read (Skills, Workers) must not wait for the Knowledge and Policies
// file walk, and sibling folders are listed side by side.

describe("BrainPage reads in parallel", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  it("starts the library read while the file listings are still pending", async () => {
    const listDir = vi.fn((path: string) => {
      if (path.endsWith("/knowledge")) {
        return Promise.resolve(ok([
          { name: "a", path: `${path}/a`, isDir: true },
          { name: "b", path: `${path}/b`, isDir: true },
        ]));
      }
      return new Promise(() => undefined);
    });
    const files = { listDir, getFileContent: vi.fn(() => new Promise(() => undefined)) };
    const library = { getCompany: vi.fn(async () => ok({ workers: [], skills: [] })) };
    const appShell = { setActiveCompany: vi.fn(async () => ok(undefined)) };
    component = mount(BrainPage, {
      target: document.body,
      props: {
        page: "workers",
        slug: "acme",
        files: files as never,
        library: library as never,
        appShell: appShell as never,
      },
    });
    await vi.waitFor(() => expect(library.getCompany).toHaveBeenCalledWith("acme"));
    // Both subfolders of knowledge are listed without waiting on each other.
    await vi.waitFor(() => {
      const paths = listDir.mock.calls.map(([p]) => p);
      expect(paths).toContain("companies/acme/knowledge/a");
      expect(paths).toContain("companies/acme/knowledge/b");
    });
  });
});
