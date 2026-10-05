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

// A faded object sits between the age floor and the faded baseline (oldest lowest).
const faded = (el: SVGGElement): boolean => {
  const t = Number.parseFloat(el.style.getPropertyValue("--t"));
  return t >= 0.06 && t <= 0.25;
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
