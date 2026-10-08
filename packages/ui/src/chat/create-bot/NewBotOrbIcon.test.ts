// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount, type ComponentProps } from "svelte";
import NewBotOrbIcon from "./NewBotOrbIcon.svelte";
import NewBotStepHead from "./NewBotStepHead.svelte";

let components: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const c of components) await unmount(c);
  components = [];
  document.body.replaceChildren();
});

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function orb(kind: "cloud" | "local"): HTMLElement {
  const target = host();
  components.push(mount(NewBotOrbIcon, { target, props: { kind } }));
  return target;
}

function head(props: ComponentProps<typeof NewBotStepHead>): HTMLElement {
  const target = host();
  components.push(mount(NewBotStepHead, { target, props }));
  return target;
}

describe("NewBotOrbIcon", () => {
  it("is decorative, warm for Cloud and cool for Local", async () => {
    const cloud = orb("cloud");
    const local = orb("local");
    await tick();
    const cloudSvg = cloud.querySelector("svg")!;
    const localSvg = local.querySelector("svg")!;
    expect(cloudSvg.getAttribute("aria-hidden")).toBe("true");
    expect(localSvg.getAttribute("aria-hidden")).toBe("true");
    expect(cloudSvg.getAttribute("width")).toBe("54");
    const stop = (svg: SVGElement) => svg.querySelector("radialGradient stop")?.getAttribute("stop-color");
    expect(stop(cloudSvg)).toBe("rgba(255, 204, 186, 0.92)");
    expect(stop(localSvg)).toBe("rgba(170, 190, 255, 0.55)");
    // The fill's center sits up and to the left.
    const fill = cloudSvg.querySelector("radialGradient")!;
    expect(fill.getAttribute("cx")).toBe("0.35");
    expect(fill.getAttribute("cy")).toBe("0.3");
    // A white glyph inside each.
    expect(cloudSvg.querySelector(".new-bot-orb-glyph")).toBeTruthy();
    expect(localSvg.querySelector(".new-bot-orb-glyph")).toBeTruthy();
  });

  it("gives every orb its own gradient ids, so two on a page never collide", async () => {
    const a = orb("cloud");
    const b = orb("cloud");
    await tick();
    const ids = [...document.querySelectorAll("radialGradient")].map((g) => g.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const host of [a, b]) {
      for (const el of host.querySelectorAll("[fill^='url(#']")) {
        const ref = el.getAttribute("fill")!.slice(5, -1);
        expect(host.querySelector(`[id="${ref}"]`), ref).toBeTruthy();
      }
    }
  });
});

describe("NewBotStepHead progress", () => {
  it("puts Back and the step bars on one row, marking done, current and upcoming steps", async () => {
    const host = head({
      total: 4,
      current: 3,
      onback: () => {},
      backTestId: "back",
      kicker: "A new teammate",
      lead: "Where should",
      em: "Nova",
      tail: "live?",
    });
    await tick();
    const row = host.querySelector(".new-bot-step-top")!;
    expect(row.querySelector('[data-testid="back"]')).toBeTruthy();
    const progress = row.querySelector('[data-testid="new-bot-progress"]')!;
    expect(progress.getAttribute("role")).toBe("img");
    expect(progress.getAttribute("aria-label")).toBe("Step 3 of 4");
    const bars = [...progress.querySelectorAll("span")];
    expect(bars.map((b) => (b.classList.contains("active") ? "now" : b.classList.contains("done") ? "done" : "next"))).toEqual([
      "done",
      "done",
      "now",
      "next",
    ]);
  });

  it("keeps the bars on the row when a step has no Back", async () => {
    const host = head({ total: 2, current: 1, kicker: "k", lead: "Enter a", em: "name." });
    await tick();
    expect(host.querySelector(".new-bot-step-top .new-bot-back")).toBeNull();
    expect(host.querySelector(".new-bot-step-top [data-testid='new-bot-progress']")?.getAttribute("aria-label")).toBe("Step 1 of 2");
  });
});
