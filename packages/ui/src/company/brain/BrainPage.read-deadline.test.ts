// @vitest-environment happy-dom

// BLANK-1: a company files read that never answers must not hold the
// Knowledge/Policies/Skills/Workers placeholder forever. After the shared read
// deadline the page shows the failed-read line and Try again.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectPendingRead } from "../../common/read-loader.test-support.js";
import BrainPage from "./BrainPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BrainPage pending read (BLANK-3)", () => {
  it.each(["knowledge", "policies", "skills", "workers"] as const)(
    "a %s read that never answers keeps loading with a waiting line and Try again, never a failed state",
    async (page) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const never = () => new Promise<never>(() => {});
      const files = { listDir: vi.fn(never), getFileContent: vi.fn(never) };
      const library = { getCompany: vi.fn(never) };
      component = mount(BrainPage, {
        target: document.body,
        props: { page, slug: `blank-1-${page}`, files: files as never, library: library as never, shell: null, settings: null },
      });
      flushSync();
      expect(document.querySelector("[data-testid='brain-loading']")).toBeTruthy();
      await expectPendingRead(document, "brain-loader");
      // BLANK-2: no zero count next to the failed read.
      expect(document.querySelector(".toolbar")?.textContent).not.toMatch(/\b0 (files|skills|workers|hard)\b/);
    },
  );
});
