// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import AtlasLandingHost from "./AtlasLandingHost.svelte";
import { loadAtlas } from "./atlas-lazy.js";
import { createAtlasCache } from "../atlas/atlas-cache.js";
import { smokeAtlasGraph } from "../atlas/atlas-model.js";
import { configureProjectsApi } from "../projects/local-projects.js";
import { fakeProjectsApi } from "../projects/testing.js";

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

  it("QA-016: a company with no cloud uid says so instead of loading forever", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: { companyLabel: "Local Co", workingNow: [], companyUid: null },
      }),
    );
    await settle(target);
    expect(target.textContent).not.toContain("Loading Local Co");
    expect(target.querySelector("[data-testid='atlas-landing-unlinked']")).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-landing']")?.getAttribute("aria-busy")).toBeNull();
  });
});

describe("AtlasLandingHost local first page (QA-016 re-test)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  async function waitFor(target: HTMLElement, test: () => boolean): Promise<void> {
    await loadAtlas();
    for (let i = 0; i < 100; i += 1) {
      if (test()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
    }
  }

  const stamp = "2026-10-01T12:00:00.000Z";
  const firstPage = {
    revision: "r1",
    complete: false,
    objects: [
      { key: "projects/alpha/", lastModified: stamp, size: 0 },
      { key: "projects/beta/", lastModified: stamp, size: 0 },
      { key: "knowledge/guides/", lastModified: stamp, size: 0 },
      { key: "policies/no-secrets.md", lastModified: stamp, size: 10 },
    ],
  };
  const fullListing = {
    revision: "r1",
    complete: true,
    objects: [
      { key: "projects/alpha/prd.json", lastModified: stamp, size: 40 },
      { key: "projects/alpha/notes.md", lastModified: stamp, size: 4 },
      { key: "projects/beta/prd.json", lastModified: stamp, size: 40 },
      { key: "knowledge/guides/setup.md", lastModified: stamp, size: 4 },
      { key: "policies/no-secrets.md", lastModified: stamp, size: 10 },
      { key: "workers/scout/worker.yaml", lastModified: stamp, size: 10 },
      { key: "skills/triage/SKILL.md", lastModified: stamp, size: 10 },
    ],
  };

  it("paints the partial map from the first page before the full load completes", async () => {
    localStorage.clear();
    const listing = deferred<unknown>();
    const atlasLocal = {
      firstPage: vi.fn(async () => firstPage),
      listing: vi.fn(() => listing.promise),
      readText: vi.fn(async (_slug: string, key: string) =>
        key === "projects/alpha/prd.json"
          ? JSON.stringify({ metadata: { repoPath: "repos/private/alpha-app" } })
          : null,
      ),
    };
    const atlasSource = { listPage: vi.fn(), readText: vi.fn() };
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: {
          companyLabel: "Indigo",
          workingNow: [],
          slug: "indigo-partial-test",
          companyUid: "co_partial_test",
          atlasLocal,
          atlasSource,
        },
      }),
    );
    const count = () => target.querySelector("[data-testid='atlas-object-count']")?.textContent ?? "";
    await waitFor(target, () => Boolean(target.querySelector("[data-testid='atlas-map']")));

    // Partial map is on screen while the full listing is still pending.
    expect(target.querySelector("[data-testid='atlas-skeleton']")).toBeNull();
    expect(target.querySelector("[data-testid='atlas-error']")).toBeNull();
    expect(count()).toBe("4 objects");
    expect(target.querySelector("[data-testid='atlas-loading-more']")).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-node-project:projects/alpha/']")).not.toBeNull();
    expect(atlasLocal.firstPage).toHaveBeenCalledWith("indigo-partial-test");
    expect(atlasLocal.readText).not.toHaveBeenCalled();
    expect(atlasSource.listPage).not.toHaveBeenCalled();

    listing.resolve(fullListing);
    await waitFor(target, () => !target.querySelector("[data-testid='atlas-loading-more']"));
    expect(target.querySelector("[data-testid='atlas-loading-more']")).toBeNull();
    // Full map adds workers, skills and the repo the alpha PRD links to.
    expect(count()).toBe("7 objects");
    expect(target.querySelector("[data-testid='atlas-node-repo:repos/private/alpha-app/']")).not.toBeNull();
    expect(atlasLocal.readText).toHaveBeenCalledWith("indigo-partial-test", "projects/alpha/prd.json");
  });

  it("falls back to the vault listing when the company folder is not on this machine", async () => {
    localStorage.clear();
    const atlasLocal = {
      firstPage: vi.fn(async () => null),
      listing: vi.fn(async () => null),
      readText: vi.fn(async () => null),
    };
    const atlasSource = {
      listPage: vi.fn(async (_c: string, prefix: string) => ({
        objects: prefix === "projects/" ? [{ key: "projects/gamma/prd.json", lastModified: stamp }] : [],
        cursor: null,
      })),
      readText: vi.fn(async () => null),
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: {
          companyLabel: "Indigo",
          workingNow: [],
          slug: "indigo-fallback-test",
          companyUid: "co_fallback_test",
          atlasLocal,
          atlasSource,
        },
      }),
    );
    await waitFor(target, () => Boolean(target.querySelector("[data-testid='atlas-node-project:projects/gamma/']")));
    expect(target.querySelector("[data-testid='atlas-node-project:projects/gamma/']")).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-loading-more']")).toBeNull();
    expect(atlasSource.listPage).toHaveBeenCalled();
  });
});

describe("AtlasLandingHost projects in progress (QA-065)", () => {
  // boring-ecom's board: three started projects, one done, one not started,
  // plus another company's started project that must not count.
  const boardProjects = [
    { id: "subscription-growth-calculator", title: "Calculator", company: "boring-ecom", status: "planned", storyCount: 11, storiesComplete: 5 },
    { id: "skio-retention-automation", title: "Skio", company: "boring-ecom", status: "", storyCount: 15, storiesComplete: 3 },
    { id: "strawberry-weekly-retention-report", title: "Report", company: "boring-ecom", status: "in_progress", storyCount: 7, storiesComplete: 6 },
    { id: "shipped", title: "Shipped", company: "boring-ecom", status: "active", storyCount: 4, storiesComplete: 4 },
    { id: "idea", title: "Idea", company: "boring-ecom", status: "planned", storyCount: 3, storiesComplete: 0 },
    { id: "other", title: "Other", company: "amass", status: "in_progress", storyCount: 5, storiesComplete: 2 },
  ];

  afterEach(() => configureProjectsApi(null));

  function rollupText(target: HTMLElement): string {
    return target.querySelector("[data-testid='atlas-inspector-rollup']")?.textContent ?? "";
  }

  async function waitForText(target: HTMLElement, text: string): Promise<void> {
    await loadAtlas();
    for (let i = 0; i < 50; i += 1) {
      if (rollupText(target).includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
    }
  }

  it("counts the same in-progress projects as the Projects board on the rendered map", async () => {
    configureProjectsApi(fakeProjectsApi(async () => boardProjects));
    // The map graph carries no story rollups, as the local folder map does.
    const graph = smokeAtlasGraph();
    graph.nodes = graph.nodes.map(({ stories: _stories, ...n }) => n);
    const storage = new Map([["hq.atlas.v1:co_boring", JSON.stringify(graph)]]);
    const atlasCache = createAtlasCache({
      fetcher: vi.fn(async () => graph),
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: { companyLabel: "Boring", workingNow: [], slug: "boring-ecom", companyUid: "co_boring", atlasCache },
      }),
    );
    await waitForText(target, "3 projects in progress");
    expect(target.querySelector("[data-testid='atlas-map']")).not.toBeNull();
    expect(rollupText(target)).toContain("3 projects in progress");
  });

  it("uses the board count on the landing summary before the map is linked", async () => {
    configureProjectsApi(fakeProjectsApi(async () => boardProjects));
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: { companyLabel: "Boring", workingNow: [], slug: "boring-ecom" },
      }),
    );
    await waitForText(target, "3 projects in progress");
    expect(rollupText(target)).toContain("3 projects in progress");
  });
});
