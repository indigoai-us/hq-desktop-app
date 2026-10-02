// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AtlasView from "./AtlasView.svelte";
import { createAtlasCache } from "./atlas-cache.js";
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

describe("AtlasView", () => {
  it("shows a skeleton in the first frame with no cache, then paints the graph", async () => {
    mountView();
    expect(host.querySelector(sel("atlas-skeleton"))).not.toBeNull();
    expect(host.querySelector(sel("atlas-inspector"))).not.toBeNull();
    await settle();
    expect(host.querySelector(sel("atlas-skeleton"))).toBeNull();
    expect(host.querySelectorAll('[data-testid^="atlas-node-"]').length).toBe(
      smokeAtlasGraph().nodes.length,
    );
    expect(host.querySelectorAll('[data-testid="atlas-edge"]').length).toBe(0);
  });

  it("paints cached data synchronously on mount", async () => {
    const cache = createAtlasCache({ fetcher: async () => smokeAtlasGraph() });
    await cache.refresh("cmp_indigo");
    mountView(cache);
    expect(host.querySelector(sel("atlas-skeleton"))).toBeNull();
    expect(host.querySelector(sel(`atlas-node-${RAIL}`))).not.toBeNull();
  });

  it("selecting a project shows its edges, related labels, and stories; Esc closes", async () => {
    mountView();
    await settle();
    const node = host.querySelector(sel(`atlas-node-${RAIL}`)) as SVGGElement;
    flushSync(() => {
      node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
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
    const svg = host.querySelector("svg")!;
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
    flushSync(() => {
      hist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(host.querySelector(sel("atlas-scrub-date"))?.textContent).toBe("Sep 29");
    const policy = host.querySelector(sel("atlas-node-policy:policies/tenancy.md")) as SVGGElement;
    expect(policy.style.getPropertyValue("--t")).toBe("0.25");
    expect(policy.getAttribute("transform")).toBeNull();
    flushSync(() => {
      hist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(host.querySelector(sel("atlas-scrub-date"))?.textContent).toBe("Now");
    expect(policy.style.getPropertyValue("--t")).toBe("");
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
    expect(host.querySelector(sel("atlas-skeleton"))).toBeNull();
    const text = host.querySelector(sel("atlas-error"))?.textContent ?? "";
    expect(text).toContain("The map didn't load");
    expect(text).not.toContain("401");
    expect(text).not.toContain("raw");
    (host.querySelector(sel("atlas-retry")) as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(host.querySelector(sel(`atlas-node-${RAIL}`))).not.toBeNull();
    });
    expect(host.querySelector(sel("atlas-error"))).toBeNull();
    expect(calls).toBe(2);
  });

  it("QA-016: a fetch that never settles is cut off by the timeout and shows the error state", async () => {
    const cache = createAtlasCache({
      fetcher: () => new Promise<unknown>(() => undefined),
      timeoutMs: 20,
    });
    mountView(cache);
    expect(host.querySelector(sel("atlas-skeleton"))).not.toBeNull();
    await vi.waitFor(() => {
      expect(host.querySelector(sel("atlas-error"))).not.toBeNull();
    });
    expect(host.querySelector(sel("atlas-skeleton"))).toBeNull();
    expect(host.querySelector(sel("atlas-retry"))).not.toBeNull();
  });
});
