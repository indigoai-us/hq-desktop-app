// @vitest-environment happy-dom

// BLANK-1: a vault folder read that never answers must not hold the Library
// tree skeleton forever; after the shared read deadline it shows plain copy
// and Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { READ_DEADLINE_MS } from "../../common/read-deadline.js";
import VaultTree from "./VaultTree.svelte";
import type { Vault } from "./vault-model.js";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ACME: Vault = { id: "company:acme", kind: "company", label: "Acme", root: "companies/acme", slug: "acme" };

describe("VaultTree read deadline (BLANK-1)", () => {
  it("a root read that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    component = mount(VaultTree, {
      target: document.body,
      props: {
        vault: ACME,
        listDir: () => new Promise(() => {}),
        activePath: null,
        showSystem: false,
        reloadKey: 0,
        onopen: () => {},
      },
    });
    flushSync();
    expect(document.querySelector(".vt-skeleton")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector(".vt-skeleton")).toBeNull();
    expect(document.querySelector("[data-testid='vault-tree-error']")?.textContent).toContain("Couldn't read this vault.");
    expect(document.querySelector("[data-testid='vault-tree-retry']")).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });
});
