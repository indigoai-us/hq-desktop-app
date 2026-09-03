// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AtlasTab from "./AtlasTab.svelte";
import {
  ATLAS_SMOKE_FIXTURE,
  makeAtlasStressGraph,
  parseAtlasGraph,
} from "./atlas-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("AtlasTab", () => {
  it("renders every smoke-fixture node and shows a hover card on a person", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AtlasTab, {
      target: host,
      props: { graph: ATLAS_SMOKE_FIXTURE },
    });
    expect(host.querySelector('[data-testid="company-tab-atlas"]')).not.toBeNull();
    for (const node of ATLAS_SMOKE_FIXTURE.nodes) {
      expect(
        host.querySelector(`[data-testid="atlas-node-${node.id}"]`),
      ).not.toBeNull();
    }
    const person = host.querySelector<SVGGElement>(
      '[data-testid="atlas-node-prs_corey"]',
    );
    flushSync(() => {
      person?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      person?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    });
    const card = host.querySelector('[data-testid="atlas-hover-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? "").toContain("Corey Epstein");
    expect(host.querySelector('[data-testid="atlas-people-pane"]')?.textContent).toContain(
      "Jacob Posel",
    );
  });

  it("paints 200-node graphs without dropping nodes", () => {
    const graph = makeAtlasStressGraph(200);
    host = document.createElement("div");
    document.body.appendChild(host);
    const start = performance.now();
    component = mount(AtlasTab, { target: host, props: { graph } });
    const elapsed = performance.now() - start;
    expect(host.querySelectorAll("[data-testid^='atlas-node-']").length).toBe(200);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("parseAtlasGraph", () => {
  it("round-trips the smoke fixture", () => {
    expect(parseAtlasGraph(ATLAS_SMOKE_FIXTURE)?.nodes).toHaveLength(5);
  });
});
