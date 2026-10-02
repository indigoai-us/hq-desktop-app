// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import AtlasLandingHost from "./AtlasLandingHost.svelte";
import { loadAtlas } from "./atlas-lazy.js";
import { createAtlasCache } from "../atlas/atlas-cache.js";
import { smokeAtlasGraph } from "../atlas/atlas-model.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

async function settle(target: HTMLElement): Promise<void> {
  // The Atlas chunk is a dynamic import; under a cold transform it can take
  // longer than the macrotask loop below, so wait for the module first.
  await loadAtlas();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    if (target.querySelector("[data-testid='atlas-inspector']")) return;
  }
}

describe("AtlasLandingHost (US-009)", () => {
  it("paints the skeleton in the first frame, then the company roll-up", async () => {
    const onopenperson = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: {
          companyLabel: "Indigo",
          workingNow: [
            { nodeId: "person:u_zed", name: "Zed", bot: false },
            { nodeId: "person:b_scout", name: "Scout", bot: true },
          ],
          onopenperson,
        },
      }),
    );
    flushSync();
    // First frame: skeleton and loading note, never a blank pane or spinner.
    expect(target.querySelector("[data-testid='atlas-landing-skeleton']")).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-landing']")?.getAttribute("aria-busy")).toBe("true");
    expect(target.textContent).toContain("Loading Indigo");

    await settle(target);
    const inspector = target.querySelector("[data-testid='atlas-inspector']");
    expect(inspector).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-landing-skeleton']")).toBeNull();
    const rollup = target.querySelector("[data-testid='atlas-inspector-rollup']")?.textContent ?? "";
    expect(rollup).toContain("2 live");
    expect(rollup).toContain("0 projects in progress");
    // The landing has no map yet, so the objects chip stays hidden.
    expect(rollup).not.toContain("objects");
    const working = target.querySelectorAll("[data-testid='atlas-inspector-working-now'] button");
    expect([...working].map((b) => b.textContent?.trim())).toEqual(["ZE Zed", "⌁ Scout"]);
    (working[0] as HTMLButtonElement).click();
    expect(onopenperson).toHaveBeenCalledWith("u_zed");
  });
});

describe("AtlasLandingHost live presence (US-013)", () => {
  const rail = "project:projects/hq-desktop-console-rail/";

  async function waitFor(target: HTMLElement, selector: string): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if (target.querySelector(selector)) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
    }
  }

  function mountMap(props: Record<string, unknown>) {
    const graph = smokeAtlasGraph();
    const storage = new Map([["hq.atlas.v1:co_indigo", JSON.stringify(graph)]]);
    const fetcher = vi.fn(async () => graph);
    const atlasCache = createAtlasCache({
      fetcher,
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    const app = mount(AtlasLandingHost, {
      target,
      props: { companyLabel: "Indigo", workingNow: [], companyUid: "co_indigo", atlasCache, ...props },
    });
    mounted.push(app);
    return { target, fetcher };
  }

  it("given a live bot on a project, the project shows a halo and the bot chip docked beside it", async () => {
    const { target, fetcher } = mountMap({
      actors: [{ actorUid: "b_deacon", name: "deacon", bot: true, projectId: "hq-desktop-console-rail" }],
    });
    flushSync();
    // First frame is still the skeleton, never blank.
    expect(target.querySelector("[data-testid='atlas-landing-skeleton']")).not.toBeNull();
    await waitFor(target, "[data-testid='atlas-map']");
    // Cached map paints; refresh runs in the background.
    expect(target.querySelector(`[data-testid='atlas-halo-${rail}']`)).not.toBeNull();
    const chip = target.querySelector("[data-testid='atlas-chip-b_deacon']");
    expect(chip?.getAttribute("data-node")).toBe(rail);
    expect(chip?.getAttribute("data-kind")).toBe("bot");
    expect(chip?.querySelector("rect")).not.toBeNull();
    expect(chip?.querySelector("line.connector")).not.toBeNull();
    expect(fetcher).toHaveBeenCalledWith("co_indigo");
    // Only one halo: nobody else is live.
    expect(target.querySelectorAll(".halo")).toHaveLength(1);
  });

  it("filters the map to a person's objects and dims the rest; clearing restores", async () => {
    const onclearfilter = vi.fn();
    const { target } = mountMap({
      actors: [
        { actorUid: "u_amy", name: "Amy", bot: false, projectId: "hq-desktop-console-rail" },
        { actorUid: "b_scout", name: "scout", bot: true, projectId: "billing-v2" },
      ],
      filterActor: "u_amy",
      onclearfilter,
    });
    await waitFor(target, "[data-testid='atlas-map']");
    const node = (id: string) => target.querySelector(`[data-testid='atlas-node-${id}']`)!;
    expect(node(rail).classList.contains("dim")).toBe(false);
    expect(node("project:projects/billing-v2/").classList.contains("dim")).toBe(true);
    expect(target.querySelector("[data-testid='atlas-chip-u_amy']")?.classList.contains("dim")).toBe(false);
    expect(target.querySelector("[data-testid='atlas-chip-b_scout']")?.classList.contains("dim")).toBe(true);
    expect(target.querySelector("[data-testid='atlas-chip-u_amy'] circle")).not.toBeNull();
    const chipText = target.querySelector("[data-testid='atlas-filter-chip']")?.textContent ?? "";
    expect(chipText).toContain("Amy");
    (target.querySelector("[aria-label='Clear people filter']") as HTMLButtonElement).click();
    expect(onclearfilter).toHaveBeenCalledOnce();
  });

  it("shows every object at full strength with no filter", async () => {
    const { target } = mountMap({ actors: [] });
    await waitFor(target, "[data-testid='atlas-map']");
    expect(target.querySelectorAll("[data-testid^='atlas-node-'].dim")).toHaveLength(0);
    expect(target.querySelector("[data-testid='atlas-filter-chip']")).toBeNull();
  });
});
