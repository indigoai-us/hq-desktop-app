// @vitest-environment happy-dom

// BLANK-1: a folder listing that never answers must not hold the Vault tree
// placeholder forever; after the shared read deadline it shows the failed
// line and Retry. A 403-shaped refusal reads as no access, in plain words.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { expectPendingRead } from "../common/read-loader.test-support.js";
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

describe("CompanyFileTree pending read (BLANK-3)", () => {
  it("a listing that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    component = mount(CompanyFileTree, {
      target: document.body,
      props: { rootPath: "companies/acme", loadChildren: () => new Promise(() => {}) },
    });
    flushSync();
    expect(document.querySelector("[data-testid='file-tree-loading']")).toBeTruthy();
    await expectPendingRead(document, "file-tree-loader");
  });

  it("a 403-shaped refusal reads as no access", () => {
    expect(fileTreeErrorReason(new Error("hq-pro returned 403 Forbidden for list_hq_dir"))).toBe(
      "You don't have access to this company's files.",
    );
  });
});
