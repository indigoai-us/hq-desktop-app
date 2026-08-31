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

describe("LibraryOverlay host capabilities", () => {
  it("hides Workers for web and any desktop host without the worker-detail capability", async () => {
    for (const [kind, capabilities] of [
      ["web", WEB_CAPABILITIES],
      ["desktop", { ...TAURI_CAPABILITIES, canSpawnSessions: false }],
    ] as const) {
      host = document.createElement("div");
      document.body.appendChild(host);
      component = mount(LibraryOverlay, {
        target: host,
        props: { adapter: adapter(kind, capabilities), tab: "workers" },
      });
      await flush();

      expect(host.querySelector('[data-testid="library-nav-workers"]')).toBeNull();
      expect(host.querySelector('[data-testid="library-workers-panel"]')).toBeNull();

      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });
});
