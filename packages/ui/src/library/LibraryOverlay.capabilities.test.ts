// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import {
  TAURI_CAPABILITIES,
  WEB_CAPABILITIES,
  ok,
  type Capability,
  type PlatformAdapter,
} from "@hq/platform";
import LibraryOverlay from "./LibraryOverlay.svelte";

const worker = {
  id: "worker_planner",
  name: "Planner",
  type: "agent",
  description: "Plans work",
  scope: "root" as const,
  status: "ready",
  path: "workers/planner",
};

function adapter(
  kind: "web" | "desktop",
  capabilities: PlatformAdapter["capabilities"],
): PlatformAdapter {
  return {
    kind,
    capabilities,
    isAvailable: (capability: Capability) => capabilities[capability],
    library: {
      getRoot: vi.fn(async () => ok({ workers: [worker], skills: [] })),
      getCompany: vi.fn(async () => ok({ workers: [], skills: [] })),
      getWorkerDetail: vi.fn(async () =>
        ok({ ...worker, skills: [], instructions: "Use the plan." }),
      ),
      getSkillDetail: vi.fn(async () => ok({})),
    },
    marketplace: {
      listListings: vi.fn(async () => ok({ listings: [] })),
      myListings: vi.fn(async () => ok({ listings: [] })),
    },
    sync: { listSyncableWorkspaces: vi.fn(async () => ok([])) },
    packages: { listPackages: vi.fn(async () => ok([])) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  flushSync();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Marketplace page (OWNER-R33)", () => {
  function mountPage(kind: "web" | "desktop", capabilities: PlatformAdapter["capabilities"], tab?: string) {
    host = document.createElement("div");
    document.body.appendChild(host);
    const a = adapter(kind, capabilities);
    component = mount(LibraryOverlay, {
      target: host,
      props: { adapter: a, ...(tab ? { tab: tab as never } : {}) },
    });
    return a;
  }

  it("is titled Marketplace, lists Browse, Installed, Submit, and opens on Browse", async () => {
    const a = mountPage("desktop", TAURI_CAPABILITIES);
    await flush();
    expect(host.querySelector('[data-testid="library-overlay-title"]')?.textContent).toBe("Marketplace");
    expect(host.textContent).not.toContain("Library");
    expect(host.textContent).not.toContain("skills available to you");
    const rows = [...host.querySelectorAll('[data-testid="library-overlay-nav"] button')];
    expect(rows.map((r) => r.textContent?.trim())).toEqual(["Browse", "Installed", "Submit"]);
    expect(host.querySelector('[data-testid="library-nav-marketplace"]')?.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector('[data-testid="library-marketplace-panel"]')).not.toBeNull();
    // Skills and Workers are gone from this page, and it no longer reads them.
    expect(host.querySelector('[data-testid="library-nav-skills"]')).toBeNull();
    expect(host.querySelector('[data-testid="library-nav-workers"]')).toBeNull();
    expect(a.library.getRoot).not.toHaveBeenCalled();
  });

  it("has no Back button; the top bar's back and forward own history", async () => {
    mountPage("desktop", TAURI_CAPABILITIES);
    await flush();
    expect(host.querySelector('[data-testid="library-back"]')).toBeNull();
    expect(host.querySelector(".page-header-back")).toBeNull();
  });

  it("sends the retired Skills and Workers tabs to Browse, on desktop and web", async () => {
    for (const [kind, capabilities] of [
      ["desktop", TAURI_CAPABILITIES],
      ["web", WEB_CAPABILITIES],
    ] as const) {
      for (const tab of ["skills", "workers"]) {
        mountPage(kind, capabilities, tab);
        await flush();
        expect(host.querySelector('[data-testid="library-marketplace-panel"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="library-skills-panel"]')).toBeNull();
        expect(host.querySelector('[data-testid="library-workers-panel"]')).toBeNull();
        if (component) await unmount(component);
        component = null;
        host.remove();
      }
    }
  });
});
