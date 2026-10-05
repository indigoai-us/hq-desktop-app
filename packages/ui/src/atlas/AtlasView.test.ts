// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AtlasView from "./AtlasView.svelte";
import { AtlasLoadError, createAtlasCache } from "./atlas-cache.js";
import { expectPendingRead } from "../common/read-loader.test-support.js";
import { ATLAS_SMOKE_DETAIL, smokeAtlasGraph } from "./atlas-model.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const RAIL = "project:projects/hq-desktop-console-rail/";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function sel(id: string): string {
  return `[data-testid="${id.replace(/"/g, '\\"')}"]`;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

function mountView(cache = createAtlasCache({ fetcher: async () => smokeAtlasGraph() })) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AtlasView, {
    target: host,
    props: {
      companyUid: "cmp_indigo",
      companyName: "Indigo",
      cache,
      nowMs: NOW,
      presence: [{ nodeId: RAIL, name: "Corey", bot: false, signal: "editing" }],
      loadDetail: async () => ATLAS_SMOKE_DETAIL,
    },
  });
  return cache;
}

/**
 * A real press: pointerdown on the node, pointerup delivered wherever the
 * engine sends it (window here, since the map tracks the release on window).
 */
function press(target: Element, upTarget: EventTarget, dx = 0, dy = 0): void {
  const at = (x: number, y: number) => ({ bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y });
  flushSync(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", at(100, 100)));
  });
  if (dx || dy) {
    flushSync(() => {
      window.dispatchEvent(new PointerEvent("pointermove", at(100 + dx, 100 + dy)));
    });
  }
  flushSync(() => {
    upTarget.dispatchEvent(new PointerEvent("pointerup", at(100 + dx, 100 + dy)));
  });
}

function inspectorPath(): string | null | undefined {
  return host.querySelector(sel("atlas-inspector-path"))?.textContent;
}

import { ATLAS_AGE_FLOOR, ATLAS_TOUCH_FADED } from "./atlas-timeline.js";

// A faded object sits between the age floor and the faded baseline (oldest lowest).
const faded = (el: SVGGElement): boolean => {
  const t = Number.parseFloat(el.style.getPropertyValue("--t"));
  return t >= ATLAS_AGE_FLOOR && t <= ATLAS_TOUCH_FADED;
};

describe("AtlasView", () => {
  it("QA-064: a click on a node opens its inspector exactly like Return", async () => {
    mountView();
    await settle();
    const svg = (host.querySelector(sel("atlas-world")) as SVGGElement).ownerSVGElement!;
    const node = () => host.querySelector(sel(`atlas-node-${RAIL}`)) as SVGGElement;

    // Release lands on the svg (the old pointer-capture retarget) — still a node click.
    press(node(), svg);
    await settle();
    expect(inspectorPath()).toBe("projects/hq-desktop-console-rail/");
    const viaClick = host.querySelector(sel("atlas-inspector"))?.textContent;

    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(inspectorPath()).toBeUndefined();

    flushSync(() => {
      node().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(host.querySelector(sel("atlas-inspector"))?.textContent).toBe(viaClick);
  });

  it("QA-064: a drag that starts on a node pans and does not open it", async () => {
    mountView();
    await settle();
    const world = host.querySelector(sel("atlas-world")) as SVGGElement;
    const before = world.getAttribute("transform");
    press(host.querySelector(sel(`atlas-node-${RAIL}`))!, window, 40, 0);
    await settle();
    expect(world.getAttribute("transform")).not.toBe(before);
    expect(inspectorPath()).toBeUndefined();
  });

  it("QA-064: a click on empty map clears the selection", async () => {
    mountView();
    await settle();
    press(host.querySelector(sel(`atlas-node-${RAIL}`))!, window);
    await settle();
    expect(inspectorPath()).toBe("projects/hq-desktop-console-rail/");
    press((host.querySelector(sel("atlas-world")) as SVGGElement).ownerSVGElement!, window);
    await settle();
    expect(inspectorPath()).toBeUndefined();
  });

  it("shows a skeleton in the first frame with no cache, then paints the graph", async () => {
    mountView();
    expect(host.querySelector(sel("atlas-loader"))).not.toBeNull();
    expect(host.querySelector(sel("atlas-inspector"))).not.toBeNull();
    await settle();
    expect(host.querySelector(sel("atlas-loader"))).toBeNull();
    expect(host.querySelectorAll('[data-testid^="atlas-node-"]').length).toBe(
      smokeAtlasGraph().nodes.length,
    );
    expect(host.querySelectorAll('[data-testid="atlas-edge"]').length).toBe(0);
  });

  it("paints cached data synchronously on mount", async () => {
    const cache = createAtlasCache({ fetcher: async () => smokeAtlasGraph() });
    await cache.refresh("cmp_indigo");
    mountView(cache);
    expect(host.querySelector(sel("atlas-loader"))).toBeNull();
    expect(host.querySelector(sel(`atlas-node-${RAIL}`))).not.toBeNull();
  });

  it("selecting a project shows its edges, related labels, and stories; Esc closes", async () => {
    mountView();
    await settle();
    const node = host.querySelector(sel(`atlas-node-${RAIL}`)) as SVGGElement;
    press(node, window);
    await settle();
    expect(host.querySelectorAll('[data-testid="atlas-edge"]').length).toBe(3);
    expect(host.querySelector(sel("atlas-label-repo:repos/private/hq-desktop-app/"))).not.toBeNull();
    expect(host.querySelector(sel("atlas-label-worker:workers/paper-designer/"))).not.toBeNull();
    // Unrelated, not recently touched: no label.
    expect(host.querySelector(sel("atlas-label-policy:policies/tenancy.md"))).toBeNull();

    const inspector = host.querySelector(sel("atlas-inspector"))!;
    expect(inspector.querySelector(sel("atlas-inspector-kind"))?.textContent).toContain("project · live");
    expect(inspector.querySelector(sel("atlas-inspector-path"))?.textContent).toBe(
      "projects/hq-desktop-console-rail/",
    );
    expect(inspector.querySelector(sel("atlas-inspector-goal"))?.textContent).toContain("left icon rail");
    expect(inspector.querySelector(sel("atlas-inspector-stories"))?.textContent).toContain(
      "Atlas map, inspector, scrubber",
    );
    expect(inspector.querySelector(sel("atlas-inspector-related"))?.textContent).toContain("hq desktop app");
    expect(inspector.textContent).toContain("Open files");
    expect(inspector.textContent).toContain("Open board");
    expect(inspector.textContent).toContain("Message Corey");
    expect(inspector.querySelector(sel("atlas-inspector-footer"))?.textContent).toBe(
      "Born Jul 16 · Touched Sep 30 · 14 inside",
    );

    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelectorAll('[data-testid="atlas-edge"]').length).toBe(0);
    expect(host.querySelector(sel("atlas-inspector"))?.textContent).toContain("Working now");
  });

  it("pans and zooms by transform only", async () => {
    mountView();
    await settle();
    const world = host.querySelector(sel("atlas-world")) as SVGGElement;
    const before = world.getAttribute("transform");
    const svg = (host.querySelector(sel("atlas-world")) as SVGGElement).ownerSVGElement!;
    flushSync(() => {
      svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, clientX: 10, clientY: 10, bubbles: true }));
    });
    const after = world.getAttribute("transform");
    expect(after).not.toBe(before);
    expect(after).toMatch(/^translate\([^)]+\) scale\([^)]+\)$/);
    // Circles keep their world coordinates.
    const dot = host.querySelector(`${sel(`atlas-node-${RAIL}`)} .dot`);
    expect(dot?.getAttribute("cx")).toBeTruthy();
    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0" }));
    });
    expect(world.getAttribute("transform")).not.toBe(after);
  });
});

describe("AtlasView time scrubber and empty company (US-014)", () => {
  it("renders play, histogram with playhead, Born/Touched toggle, and date readout", async () => {
    mountView();
    await settle();
    const scrub = host.querySelector(sel("atlas-scrubber"))!;
    expect(scrub).not.toBeNull();
    expect(scrub.querySelector(sel("atlas-scrub-play"))).not.toBeNull();
    expect(scrub.querySelectorAll(`${sel("atlas-scrub-hist")} i`).length).toBe(30);
    expect(scrub.querySelector(sel("atlas-scrub-playhead"))).not.toBeNull();
    expect(scrub.querySelector(sel("atlas-scrub-date"))?.textContent).toBe("Now");
    expect(scrub.querySelector(sel("atlas-scrub-touched"))?.getAttribute("aria-pressed")).toBe("true");
    flushSync(() => {
      (scrub.querySelector(sel("atlas-scrub-born")) as HTMLButtonElement).click();
    });
    expect(scrub.querySelector(sel("atlas-scrub-born"))?.getAttribute("aria-pressed")).toBe("true");
  });

  it("scrubbing back fades nodes by opacity only and End returns to now", async () => {
    mountView();
    await settle();
    const hist = host.querySelector(sel("atlas-scrub-hist")) as HTMLElement;
    const node = () => host.querySelector(sel(`atlas-node-${RAIL}`)) as SVGGElement;
    expect(node().style.getPropertyValue("--t")).toBe("");
    const policyAtNow = host.querySelector(sel("atlas-node-policy:policies/tenancy.md")) as SVGGElement;
    expect(faded(policyAtNow)).toBe(true);
    expect(host.querySelector(sel("atlas-nothing-active"))).toBeNull();
    flushSync(() => {
      hist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(host.querySelector(sel("atlas-scrub-date"))?.textContent).toBe("Sep 29");
    const policy = host.querySelector(sel("atlas-node-policy:policies/tenancy.md")) as SVGGElement;
    expect(faded(policy)).toBe(true);
    expect(policy.getAttribute("transform")).toBeNull();
    flushSync(() => {
      hist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(host.querySelector(sel("atlas-scrub-date"))?.textContent).toBe("Now");
    expect(faded(policy)).toBe(true);
    expect(node().style.getPropertyValue("--t")).toBe("");
  });

  it("OWNER-009: Now with nobody live and no fresh edits stays dim and shows the hint", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AtlasView, {
      target: host,
      props: {
        companyUid: "cmp_indigo",
        companyName: "Indigo",
        cache: createAtlasCache({ fetcher: async () => smokeAtlasGraph() }),
        nowMs: NOW + 2 * 86_400_000,
        presence: [],
        loadDetail: async () => ATLAS_SMOKE_DETAIL,
      },
    });
    await settle();
    const nodes = [...host.querySelectorAll('[data-testid^="atlas-node-"]')] as SVGGElement[];
    expect(nodes.length).toBeGreaterThan(2);
    for (const n of nodes) expect(faded(n)).toBe(true);
    expect(host.querySelector(sel("atlas-nothing-active"))?.textContent).toBe("Nothing active right now");
  });

  it("an empty company shows the dashed ring, six kinds, 0 objects, and Frame all disabled", async () => {
    const opened: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AtlasView, {
      target: host,
      props: {
        companyUid: "cmp_northwind",
        companyName: "Northwind",
        cache: createAtlasCache({ fetcher: async () => ({ company: "Northwind", nodes: [] }) }),
        nowMs: NOW,
        onopenpage: (id: string) => opened.push(id),
      },
    });
    await settle();
    expect(host.querySelector(sel("atlas-empty-ring"))).not.toBeNull();
    const kinds = [...host.querySelectorAll(sel("atlas-empty-kind"))].map((n) => n.textContent);
    expect(kinds).toEqual(["Projects", "Repos", "Workers", "Skills", "Policies", "Knowledge"]);
    expect(host.querySelector(sel("atlas-object-count"))?.textContent).toBe("0 objects");
    expect((host.querySelector(sel("atlas-frame-all")) as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector(sel("atlas-scrub-play")) as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("Northwind is empty");
    (host.querySelector(sel("atlas-empty-invite")) as HTMLButtonElement).click();
    expect(opened).toEqual(["team"]);
  });
});

describe("Atlas find", () => {
  it("shows the first 8 matches and a Show more row that reveals the rest", async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `repo-${i}`, type: "repo", label: `alpha ${i}`, path: `repos/${i}`, folder: true, count: 1 }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AtlasView, {
      target: host,
      props: { companyUid: "cmp_x", companyName: "X", cache: createAtlasCache({ fetcher: async () => ({ company: "X", nodes } as never) }), nowMs: NOW },
    });
    await settle();
    const input = host.querySelector(sel("atlas-find")) as HTMLInputElement;
    flushSync(() => {
      input.dispatchEvent(new FocusEvent("focus"));
      input.value = "alpha";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const results = () => host.querySelectorAll(`${sel("atlas-find-results")} .find-row:not(.find-more)`);
    expect(results()).toHaveLength(8);
    const more = host.querySelector(sel("atlas-find-show-more")) as HTMLButtonElement;
    expect(more.textContent).toContain("Show 4 more");
    flushSync(() => more.click());
    expect(results()).toHaveLength(12);
    expect(host.querySelector(sel("atlas-find-show-more"))).toBeNull();
  });
});

describe("Atlas chunk boundary", () => {
  it("nothing outside atlas/ imports the atlas module statically", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "atlas" && entry.name !== "node_modules") walk(path);
          continue;
        }
        if (!/\.(ts|svelte)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
        const text = readFileSync(path, "utf8").replace(/\bimport\s*\(/g, "dynamic(");
        if (/(?:import|export)[^;'"]*from\s*["'][^"']*\/atlas\/[^"']*["']/.test(text)) {
          offenders.push(path.slice(src.length + 1));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it("QA-016: a failed load with no cache shows a plain error and Retry, never an endless skeleton", async () => {
    let calls = 0;
    const cache = createAtlasCache({
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error("atlas 401 Unauthorized {\"raw\":\"server\"}");
        return smokeAtlasGraph();
      },
    });
    mountView(cache);
    await vi.waitFor(() => {
      expect(host.querySelector(sel("atlas-error"))).not.toBeNull();
    });
    expect(host.querySelector(sel("atlas-loader"))).toBeNull();
    const text = host.querySelector(sel("atlas-error"))?.textContent ?? "";
    expect(text).toContain("The map didn't load");
    expect(text).not.toContain("401");
    expect(text).not.toContain("raw");
    // BLANK-2: no zero roll-up or "Nobody is working" next to the failed map.
    const rollup = host.querySelector(sel("atlas-inspector-rollup"))?.textContent ?? "";
    expect(rollup).not.toMatch(/\b0 (objects|projects)\b/);
    expect(host.textContent).not.toContain("Nobody is working");
    (host.querySelector(sel("atlas-retry")) as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(host.querySelector(sel(`atlas-node-${RAIL}`))).not.toBeNull();
    });
    expect(host.querySelector(sel("atlas-error"))).toBeNull();
    expect(calls).toBe(2);
  });

  it("QA-016: an expired sign-in explains the reason in plain words, without raw server text", async () => {
    const cache = createAtlasCache({
      fetcher: async () => {
        throw new AtlasLoadError("signed-out", "vault list http-401 {\"raw\":\"server\"}");
      },
    });
    mountView(cache);
    await vi.waitFor(() => {
      expect(host.querySelector(sel("atlas-error"))).not.toBeNull();
    });
    const text = host.querySelector(sel("atlas-error"))?.textContent ?? "";
    expect(text).toContain("sign-in has expired");
    expect(text).not.toContain("401");
    expect(text).not.toContain("raw");
    expect(host.querySelector(sel("atlas-retry"))).not.toBeNull();
  });

  it("BLANK-3: by default a fetch that never settles keeps the loader, never the error state", async () => {
    vi.useFakeTimers();
    try {
      const cache = createAtlasCache({ fetcher: () => new Promise<unknown>(() => undefined) });
      mountView(cache);
      await expectPendingRead(host, "atlas-loader");
      expect(host.querySelector(sel("atlas-error"))).toBeNull();
      expect(host.querySelector(sel("atlas-loader"))).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("QA-016: an explicit refresh limit still ends in the error state", async () => {
    const cache = createAtlasCache({
      fetcher: () => new Promise<unknown>(() => undefined),
      timeoutMs: 20,
    });
    mountView(cache);
    expect(host.querySelector(sel("atlas-loader"))).not.toBeNull();
    await vi.waitFor(() => {
      expect(host.querySelector(sel("atlas-error"))).not.toBeNull();
    });
    expect(host.querySelector(sel("atlas-loader"))).toBeNull();
    expect(host.querySelector(sel("atlas-retry"))).not.toBeNull();
  });
});

describe("Atlas: richer hover cards", () => {
  function hoverNode(id: string): Element {
    const el = host.querySelector(sel(`atlas-node-${id}`))!;
    flushSync(() => el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false })));
    return host.querySelector(sel("atlas-hover-card"))!;
  }
  const rows = (card: Element) =>
    [...card.querySelectorAll('[data-testid^="atlas-hover-"]')].map((r) => r.getAttribute("data-testid"));

  it("shows who is on a project, its stories, linked repos and counts, activity and the hint", async () => {
    mountView();
    await settle();
    const card = hoverNode(RAIL);
    expect(card.querySelector(".hc-kind")!.textContent).toBe("Project");
    expect(card.querySelector(".hc-title")!.textContent!.trim()).toBe("hq desktop console rail");
    const people = card.querySelector(sel("atlas-hover-people"))!;
    expect(people.textContent).toContain("On it now");
    expect(people.querySelectorAll(".hc-face")).toHaveLength(1);
    expect(card.querySelector(sel("atlas-hover-stories"))!.textContent).toContain("0 of 9 stories done");
    expect(card.querySelector(sel("atlas-hover-links"))!.textContent).toContain("hq desktop app");
    expect(card.querySelector(sel("atlas-hover-counts"))!.textContent).toBe("1 knowledge doc · 1 worker");
    expect(card.querySelector(sel("atlas-hover-activity"))!.textContent).toBe("Born Jul 16 · Touched 12 h ago · 14 inside");
    expect(card.textContent).toContain("Click to focus");
    // Plain text only: the card follows the pointer, so nothing in it is clickable.
    expect(card.querySelector("a, button")).toBeNull();
    // No row renders empty.
    for (const row of card.querySelectorAll('[data-testid^="atlas-hover-"]')) {
      expect(row.textContent!.trim() || row.querySelector("img, .hc-face"), row.getAttribute("data-testid")!).toBeTruthy();
    }
  });

  it("shows only the header and activity for a bare project", async () => {
    mountView();
    await settle();
    const card = hoverNode("project:projects/launch-landing/");
    expect(rows(card)).toEqual(["atlas-hover-activity"]);
    expect(card.textContent).toContain("launch landing");
  });
});

describe("Atlas: live actors not on the map", () => {
  function mountActors(
    actors: { actorUid: string; name: string; bot: boolean; repo?: string; projectId?: string; avatarUrl?: string }[],
  ) {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AtlasView, {
      target: host,
      props: {
        companyUid: "cmp_indigo",
        companyName: "Indigo",
        cache: createAtlasCache({ fetcher: async () => smokeAtlasGraph() }),
        nowMs: NOW,
        actors,
        loadDetail: async () => ATLAS_SMOKE_DETAIL,
      },
    });
  }

  it("docks 20 unplaced actors as 12 plus +8, people first, and expands to all 20", async () => {
    mountActors([
      { actorUid: "b_on", name: "placed", bot: true, projectId: "hq-desktop-console-rail" },
      ...Array.from({ length: 18 }, (_, i) => ({ actorUid: `b_${i}`, name: `bot ${String(i).padStart(2, "0")}`, bot: true })),
      { actorUid: "u_amy", name: "Amy", bot: false, repo: "elsewhere" },
      { actorUid: "u_bo", name: "Bo", bot: false },
    ]);
    await settle();
    const dock = host.querySelector(sel("atlas-unplaced"))!;
    expect(dock.textContent).toContain("Not on the map");
    expect(dock.querySelector(sel("atlas-unplaced-count"))!.textContent).toBe("20");
    const chips = () => [...dock.querySelectorAll('[data-testid^="atlas-unplaced-"][data-kind]')];
    expect(chips()).toHaveLength(12);
    expect(chips().slice(0, 2).map((c) => c.getAttribute("data-testid"))).toEqual([
      "atlas-unplaced-u_amy",
      "atlas-unplaced-u_bo",
    ]);
    const more = dock.querySelector(sel("atlas-unplaced-more")) as HTMLButtonElement;
    expect(more.textContent).toBe("+8");
    flushSync(() => more.click());
    expect(chips()).toHaveLength(20);
    expect(dock.querySelector(sel("atlas-unplaced-more"))).toBeNull();
    // The placed actor is on its node, not in the dock.
    expect(host.querySelector(sel("atlas-chip-b_on"))).not.toBeNull();
    expect(dock.querySelector(sel("atlas-unplaced-b_on"))).toBeNull();
  });

  it("draws profile and bot pictures on chips, initials and glyph without one", async () => {
    mountActors([
      { actorUid: "u_pia", name: "Pia Lee", bot: false, projectId: "hq-desktop-console-rail", avatarUrl: "data:image/png;base64,PIA" },
      { actorUid: "b_bo", name: "Bo", bot: true, projectId: "hq-desktop-console-rail", avatarUrl: "data:image/png;base64,BO" },
      { actorUid: "u_ned", name: "Ned Fox", bot: false, projectId: "hq-desktop-console-rail" },
      { actorUid: "u_amy", name: "Amy Ray", bot: false, repo: "elsewhere", avatarUrl: "data:image/png;base64,AMY" },
      { actorUid: "b_x", name: "scout", bot: true },
    ]);
    await settle();
    // On the map: an <image> fills the chip, clipped to its shape, and no initials.
    const pia = host.querySelector(sel("atlas-chip-u_pia"))!;
    const piaImage = pia.querySelector(sel("atlas-chip-picture"))!;
    expect(piaImage.getAttribute("href")).toBe("data:image/png;base64,PIA");
    expect(piaImage.getAttribute("clip-path")).toMatch(/-round\)$/u);
    expect(pia.querySelector(".initials")).toBeNull();
    const bo = host.querySelector(sel("atlas-chip-b_bo"))!;
    expect(bo.querySelector(sel("atlas-chip-picture"))!.getAttribute("clip-path")).toMatch(/-bot\)$/u);
    expect(bo.querySelector(".initials")).toBeNull();
    // No picture: the initials as before, never an empty chip.
    const ned = host.querySelector(sel("atlas-chip-u_ned"))!;
    expect(ned.querySelector(sel("atlas-chip-picture"))).toBeNull();
    expect(ned.querySelector(".initials")!.textContent).toBe("NF");
    // A picture that fails to load falls back to the initials, for that chip only.
    flushSync(() => piaImage.dispatchEvent(new Event("error")));
    expect(pia.querySelector(sel("atlas-chip-picture"))).toBeNull();
    expect(pia.querySelector(".initials")!.textContent).toBe("PL");
    expect(bo.querySelector(sel("atlas-chip-picture"))).not.toBeNull();
    // In the dock: the same picture, and the bot glyph for a bot with none.
    const amy = host.querySelector(sel("atlas-unplaced-u_amy"))!;
    const amyImg = amy.querySelector("img")!;
    expect(amyImg.getAttribute("src")).toBe("data:image/png;base64,AMY");
    expect(amy.textContent).toBe("");
    expect(host.querySelector(sel("atlas-unplaced-b_x"))!.textContent).toBe("⌁");
    // Hovering a docked person shows their picture in the card too.
    flushSync(() => amy.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false })));
    expect(host.querySelector(`${sel("atlas-hover-face")} img`)!.getAttribute("src")).toBe("data:image/png;base64,AMY");
    flushSync(() => amy.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })));
    flushSync(() => amyImg.dispatchEvent(new Event("error")));
    expect(amy.querySelector("img")).toBeNull();
    expect(amy.textContent).toBe("AR");
    // Working now in the inspector uses the same pictures.
    const working = host.querySelector(sel("atlas-inspector-working-now"))!;
    expect([...working.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toContain("data:image/png;base64,BO");
  });

  it("explains in plain words why a docked actor is not placed", async () => {
    mountActors([
      { actorUid: "u_amy", name: "Amy", bot: false, repo: "elsewhere" },
      { actorUid: "b_x", name: "scout", bot: true },
    ]);
    await settle();
    const amy = host.querySelector(sel("atlas-unplaced-u_amy"))!;
    flushSync(() => amy.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false })));
    const card = host.querySelector(sel("atlas-hover-card"))!;
    expect(card.textContent).toContain("Amy");
    expect(card.textContent).toContain("Working in elsewhere, which is not on this map");
    flushSync(() => amy.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })));
    const bot = host.querySelector(sel("atlas-unplaced-b_x"))!;
    flushSync(() => bot.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false })));
    expect(host.querySelector(sel("atlas-hover-card"))!.textContent).toContain("In a session with no project");
  });
});

describe("Atlas project dots (activity and story ring)", () => {
  it("draws a story ring only on projects that have stories", async () => {
    mountView();
    await settle();
    flushSync();
    const rings = [...host.querySelectorAll('[data-testid^="atlas-ring-"]')];
    const ids = rings.map((el) => el.getAttribute("data-testid")!.slice("atlas-ring-".length));
    for (const id of ids) expect(id.startsWith("project:")).toBe(true);
    expect(ids).not.toContain("project:projects/launch-landing/");
    const explorer = host.querySelector(sel("atlas-ring-project:projects/hq-explorer/"));
    expect(explorer).not.toBeNull();
    expect(Number(explorer!.getAttribute("data-done"))).toBeCloseTo(7 / 11, 2);
  });
});

describe("Atlas focus mode", () => {
  it("gathers a selected project's repo and knowledge around it, and Escape sends them home", async () => {
    mountView();
    await settle();
    flushSync();
    const repo = () => host.querySelector(sel("atlas-node-repo:repos/private/hq-desktop-app/")) as SVGGElement;
    const know = () => host.querySelector(sel("atlas-node-knowledge:knowledge/design-styles.md")) as SVGGElement;
    const other = () => host.querySelector(sel("atlas-node-knowledge:knowledge/pricing.md")) as SVGGElement;
    expect(repo().style.transform).toBe("");
    press(host.querySelector(sel(`atlas-node-${RAIL}`))!, window);
    await settle();
    flushSync();
    expect(repo().style.transform).toMatch(/^translate\(/);
    expect(know().style.transform).toMatch(/^translate\(/);
    expect(other().style.transform).toBe("");
    expect(host.querySelector('[data-testid="atlas-world"]')!.classList.contains("focusing")).toBe(true);
    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    flushSync();
    expect(repo().style.transform).toBe("");
    expect(host.querySelector('[data-testid="atlas-world"]')!.classList.contains("focusing")).toBe(false);
  });

  it("does not gather anything around a non-project", async () => {
    mountView();
    await settle();
    flushSync();
    press(host.querySelector(sel("atlas-node-repo:repos/private/hq-desktop-app/"))!, window);
    await settle();
    flushSync();
    expect(host.querySelectorAll('[data-testid^="atlas-node-"][style*="translate"]').length).toBe(0);
  });
});

describe("Atlas work motion", () => {
  it("draws faint trails from a live project to the items it touched recently, and no pulse on first paint", async () => {
    mountView();
    await settle();
    flushSync();
    const trails = host.querySelectorAll('[data-testid="atlas-trail"]');
    expect(trails.length).toBe(2);
    expect(host.querySelectorAll('[data-testid^="atlas-pulse-"]').length).toBe(0);
  });
});

describe("Atlas playback", () => {
  it("shows the scrubbed day on the map, no caption while paused, and nothing at the live edge", async () => {
    mountView();
    await settle();
    flushSync();
    expect(host.querySelector(sel("atlas-playback"))).toBeNull();
    const hist = host.querySelector(sel("atlas-scrub-hist")) as HTMLElement;
    flushSync(() => {
      hist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(host.querySelector(sel("atlas-playback-date"))?.textContent).toBe("Sep 29");
    expect(host.querySelector(sel("atlas-playback-caption"))).toBeNull();
    flushSync(() => {
      hist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(host.querySelector(sel("atlas-playback"))).toBeNull();
  });

  it("plays from the first day with a caption of that day's changes, and a manual scrub stops it", async () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => ((frame = cb), 1));
    vi.stubGlobal("cancelAnimationFrame", () => (frame = null));
    try {
      mountView();
      await settle();
      flushSync();
      flushSync(() => (host.querySelector(sel("atlas-scrub-play")) as HTMLButtonElement).click());
      expect(host.querySelector(sel("atlas-scrubber"))!.getAttribute("data-playing")).toBe("true");
      expect(host.querySelector(sel("atlas-playback-date"))?.textContent).toBe("Sep 1");
      // Sep 21: most smoke-graph objects were last touched nine days before Sep 30.
      const start = performance.now();
      flushSync(() => frame?.(start + 20 * 833 + 10));
      expect(host.querySelector(sel("atlas-playback-date"))?.textContent).toBe("Sep 21");
      expect(host.querySelector(sel("atlas-playback-caption"))?.textContent).toBe("Changed: hq explorer, paper designer and billing v2");
      const hist = host.querySelector(sel("atlas-scrub-hist")) as HTMLElement;
      flushSync(() => {
        hist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      });
      expect(host.querySelector(sel("atlas-scrubber"))!.getAttribute("data-playing")).toBeNull();
      expect(host.querySelector(sel("atlas-playback-caption"))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Atlas Today panel", () => {
  it("titles the section with the company and lists what changed today, each row flying to it", async () => {
    const graph = smokeAtlasGraph();
    graph.nodes.find((x) => x.id === RAIL)!.touched = NOW - 20 * 60_000;
    graph.nodes.find((x) => x.id === "knowledge:knowledge/pricing.md")!.touched = NOW - 60_000;
    mountView(createAtlasCache({ fetcher: async () => graph }));
    await settle();
    flushSync();
    expect(host.querySelector(sel("atlas-today-title"))?.textContent).toBe("Today at Indigo");
    const rows = [...host.querySelectorAll(sel("atlas-today-row"))];
    expect(rows.map((r) => r.querySelector(".tt")?.textContent)).toEqual(["hq desktop console rail", "pricing", "hq desktop app"]);
    expect(rows[0]!.querySelector(".mm")?.textContent).toBe("20 min ago · 0 of 9 stories");
    flushSync(() => (rows[1] as HTMLButtonElement).click());
    expect(inspectorPath()).toBe("knowledge/pricing.md");
  });

  it("shows one quiet line when nothing changed today", async () => {
    const graph = smokeAtlasGraph();
    for (const x of graph.nodes) x.touched = NOW - 3 * 86_400_000;
    mountView(createAtlasCache({ fetcher: async () => graph }));
    await settle();
    flushSync();
    expect(host.querySelector(sel("atlas-today-empty"))?.textContent).toBe("Nothing on the map changed today.");
    expect(host.querySelector(sel("atlas-today-changed"))).toBeNull();
  });

  it("pages a long day with a real Show N more", async () => {
    const graph = smokeAtlasGraph();
    for (const x of graph.nodes) x.touched = NOW - 60_000;
    mountView(createAtlasCache({ fetcher: async () => graph }));
    await settle();
    flushSync();
    expect(host.querySelectorAll(sel("atlas-today-row")).length).toBe(5);
    const more = host.querySelector(sel("atlas-today-more")) as HTMLButtonElement;
    expect(more.textContent?.trim()).toBe(`Show ${graph.nodes.length - 5} more`);
    flushSync(() => more.click());
    expect(host.querySelectorAll(sel("atlas-today-row")).length).toBe(graph.nodes.length);
  });
});
