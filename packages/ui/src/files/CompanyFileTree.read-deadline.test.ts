// @vitest-environment happy-dom

// BLANK-1: a folder listing that never answers must not hold the Vault tree
// placeholder forever; after the shared read deadline it shows the failed
// line and Retry. A 403-shaped refusal reads as no access, in plain words.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { READ_DEADLINE_MS } from "../common/read-deadline.js";
import { fileTreeErrorReason } from "./company-read-scope.js";
import CompanyFileTree from "./CompanyFileTree.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CompanyFileTree read deadline (BLANK-1)", () => {
  it("a listing that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    component = mount(CompanyFileTree, {
      target: document.body,
      props: { rootPath: "companies/acme", loadChildren: () => new Promise(() => {}) },
    });
    flushSync();
    expect(document.querySelector("[data-testid='file-tree-loading']")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector("[data-testid='file-tree-loading']")).toBeNull();
    expect(document.querySelector("[data-testid='file-tree-error-reason']")?.textContent).toBe("Could not read this folder.");
    expect(document.querySelector("[data-testid='file-tree-root-retry']")).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });

  it("a 403-shaped refusal reads as no access", () => {
    expect(fileTreeErrorReason(new Error("hq-pro returned 403 Forbidden for list_hq_dir"))).toBe(
      "You don't have access to this company's files.",
    );
  });
});
