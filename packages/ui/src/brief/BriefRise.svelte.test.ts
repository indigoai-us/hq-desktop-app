// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import BriefRise from "./BriefRise.svelte";
import { riseRevealAt, type RiseSource } from "./brief-rise.js";

const FINDING = "Keep the offline installer in the first release.";
const SOURCES: RiseSource[] = [
  { id: "claude", label: "Claude", icon: "claude", counts: { sessions: 168 }, finding: FINDING, detail: "Session · Yesterday, 4:42 PM" },
  { id: "codex", label: "Codex", icon: "codex", counts: { sessions: 244, repos: 3 }, finding: "PR #248 · Restore offline install is ready for review." },
];

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

async function show(elapsed: number): Promise<void> {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(BriefRise, {
    target,
    props: { sources: SOURCES, elapsed, reducedMotion: false, theme: "dark" },
  });
  await tick();
}

describe("BriefRise frames", () => {
  it("has no card the instant before the icon's centre crosses the horizon", async () => {
    await show(riseRevealAt(0) - 0.001);
    expect(target.querySelector('[data-testid="brief-rise-card-claude"]')).toBeNull();
    expect(target.querySelector('[data-testid="brief-rise-count"]')).toBeNull();
  });

  it("shows the count once, beside the finding card, on the horizon frame", async () => {
    await show(riseRevealAt(0));
    const card = target.querySelector('[data-testid="brief-rise-card-claude"]');
    const count = target.querySelector('[data-testid="brief-rise-count"]');
    const readout = target.querySelector(".readout");
    expect(card?.textContent).toContain(FINDING);
    expect(card?.textContent).not.toContain("sessions read");
    expect(count?.textContent).toBe("168 sessions read");
    expect(readout?.contains(card ?? null)).toBe(true);
    expect(readout?.contains(count ?? null)).toBe(true);
    expect(target.textContent?.match(/sessions read/g)).toEqual(["sessions read"]);
    const icon = target.querySelector<HTMLElement>('[data-testid="brief-rise-icon-claude"]');
    expect(icon).not.toBeNull();
    expect(icon?.dataset.whole).toBe("false");
    expect(icon?.querySelector("svg")?.getAttribute("width")).toBe("60");
    expect(icon?.querySelectorAll(".halo i").length).toBeGreaterThan(12);
    const alphas = [...(icon?.querySelectorAll<HTMLElement>(".halo i") ?? [])].map((cell) => Number(cell.style.opacity));
    expect(Math.max(...alphas)).toBeLessThan(1);
    expect(Math.min(...alphas)).toBeLessThan(Math.max(...alphas));
  });

  it("draws the whole 60 px mark, the halo, and the ripple once the icon has cleared the water", async () => {
    await show(riseRevealAt(0) + 0.35);
    const icon = target.querySelector<HTMLElement>('[data-testid="brief-rise-icon-claude"]');
    expect(icon?.dataset.whole).toBe("true");
    expect(icon?.querySelector("svg")?.getAttribute("width")).toBe("60");
    expect(icon?.querySelectorAll(".halo i").length).toBeGreaterThan(12);
    expect(target.querySelector('[data-testid="brief-rise-ripple-claude"]')?.querySelectorAll("i").length).toBeGreaterThan(0);
    expect(target.querySelector('[data-testid="brief-rise-card-claude"]')?.textContent).toContain(FINDING);
    expect(target.querySelector('[data-testid="brief-rise-count"]')?.textContent).toBe("168 sessions read");
  });

  it("keeps the whole halo out of the waterline clip once the mark has cleared the water", async () => {
    await show(riseRevealAt(0) + 0.35);
    const icon = target.querySelector<HTMLElement>('[data-testid="brief-rise-icon-claude"]');
    expect(icon?.dataset.whole).toBe("true");
    expect(icon?.closest(".above")?.classList.contains("free")).toBe(true);
  });

  it("keeps an emerging mark inside the waterline clip", async () => {
    await show(riseRevealAt(0));
    const icon = target.querySelector<HTMLElement>('[data-testid="brief-rise-icon-claude"]');
    expect(icon?.dataset.whole).toBe("false");
    expect(icon?.closest(".above")?.classList.contains("free")).toBe(false);
  });
});

describe("BriefRise welcome page", () => {
  it("frames the rise with the breadcrumb, the date and the headline", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(BriefRise, {
      target,
      props: { sources: SOURCES, elapsed: 1, reducedMotion: false, theme: "light", now: new Date(2026, 9, 17, 9) },
    });
    await tick();
    expect(target.querySelector('[data-testid="brief-rise-crumb"]')?.textContent).toBe("Home / Your Daily Brief");
    expect(target.querySelector('[data-testid="brief-rise-date"]')?.textContent).toBe("Saturday, October 17");
    const hero = target.querySelector('[data-testid="brief-rise-hero"]');
    expect(hero?.querySelector("h2")?.textContent).toBe("Your day is coming into focus.");
    expect(hero?.textContent).toContain("Your welcome edition · Taking shape");
    expect(hero?.textContent).toContain("Your agent is finding the threads that matter.");
    expect(target.querySelector('[data-testid="brief-rise"] .dawn')?.getAttribute("data-layout")).toBe("welcome");
  });

  it("shows reading progress before the first count, then the count, the time and the source", async () => {
    await show(0);
    const progress = target.querySelector('[data-testid="brief-rise-progress"]');
    expect(progress?.textContent).toContain("Reading your sources");
    expect(target.querySelector('[data-testid="brief-rise-elapsed"]')?.textContent).toBe("0 sec elapsed");
    expect(target.querySelector('[data-testid="brief-rise-step"]')?.textContent).toBe("Reading your Claude sessions");
    unmount(component!);
    component = null;
    target.remove();

    await show(riseRevealAt(1) + 3);
    expect(target.querySelector('[data-testid="brief-rise-count"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="brief-rise-progress"]')?.textContent).not.toContain("Reading your sources");
    expect(target.querySelector('[data-testid="brief-rise-step"]')?.textContent).toBe("Reading your Codex sessions");
    expect(target.querySelector('[data-testid="brief-rise-elapsed"]')?.textContent).toMatch(/^\d+ sec elapsed$/);
  });
});
