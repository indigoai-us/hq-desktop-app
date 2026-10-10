// @vitest-environment happy-dom

/**
 * Owner decision (2026-10-10): the import screen has no header Continue in
 * chat, except when the scene's code cannot load. The step would then show
 * only its loading frame, and Continue in chat is the way out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

/** While true the scene's chunk fails to load; then it loads for real. */
const door = vi.hoisted(() => ({ failing: true, loaded: false }));
vi.mock("../../shell/lazy-doors.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../shell/lazy-doors.js")>();
  return {
    ...real,
    firstRunImportDoor: {
      load: () =>
        door.failing
          ? Promise.reject(new Error("chunk failed"))
          : real.firstRunImportDoor.load().then((c) => {
              door.loaded = true;
              return c;
            }),
      peek: () => (door.loaded ? real.firstRunImportDoor.peek() : null),
      preload: () => undefined,
    },
  };
});

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import type { ImportScanHost } from "./knowledge-tree/import-runner.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("the import scene could not load", () => {
  it("shows Continue in chat on the import step, it leaves for chat, and it goes away once the scene loads", { timeout: 15000 }, async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const importHost: ImportScanHost = { run: vi.fn(), cancel: vi.fn() };
      const oncontinueinchat = vi.fn();
      host = document.createElement("div");
      document.body.appendChild(host);
      component = mount(FirstRunTakeover, {
        target: host,
        props: {
          initialName: "Pickles",
          initialStep: "tools",
          creation: { state: "ready", name: "Pickles", bot: { agentUid: "agt_1", name: "Pickles" } },
          runtimeReady: { claude: true, codex: false, grok: false },
          importHost,
          reducedMotion: true,
          onconfirmname: vi.fn(),
          onretry: vi.fn(),
          ontalk: vi.fn(),
          oncontinueinchat,
        },
      });
      await settle();
      // Before the import: no header way out.
      expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
      q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
      await settle();
      expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("context");
      expect(q('[data-testid="first-run-import-loading"]')).toBeTruthy();
      expect(q('[data-testid="first-run-import-start"]')).toBeNull();
      await vi.waitFor(() => expect(q('[data-testid="first-run-continue-in-chat"]')).toBeTruthy());
      q<HTMLButtonElement>('[data-testid="first-run-continue-in-chat"]')!.click();
      await settle();
      expect(oncontinueinchat).toHaveBeenCalledTimes(1);

      // The scene loads on a later try: Continue in chat goes away again and the scene shows.
      door.failing = false;
      await vi.waitFor(() => expect(q('[data-testid="first-run-import-start"]')).toBeTruthy(), { timeout: 8000, interval: 50 });
      await settle();
      expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
      expect(q('[data-testid="first-run-import-loading"]')).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});
