// @vitest-environment happy-dom

// BLANK-1: a vault folder read that never answers must not hold the Library
// tree skeleton forever; after the shared read deadline it shows plain copy
// and Try again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { expectPendingRead } from "../../common/read-loader.test-support.js";
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

describe("VaultTree pending read (BLANK-3)", () => {
  it("a root read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
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
    await expectPendingRead(document, "vault-tree-loader");
  });
});
