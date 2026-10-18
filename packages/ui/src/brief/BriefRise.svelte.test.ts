// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import BriefRise from "./BriefRise.svelte";
import { riseRevealAt, type RiseSource } from "./brief-rise.js";

const SOURCES: RiseSource[] = [
  { id: "claude", label: "Claude", counts: { sessions: 168 }, finding: "168 sessions in Claude Code" },
  { id: "codex", label: "Codex", counts: { sessions: 244, repos: 3 }, finding: "244 sessions across 3 repos" },
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

  it("shows the count and the card on the horizon frame", async () => {
    await show(riseRevealAt(0));
    expect(target.querySelector('[data-testid="brief-rise-card-claude"]')?.textContent).toBe("168 sessions in Claude Code");
    expect(target.querySelector('[data-testid="brief-rise-count"]')?.textContent).toBe("168 sessions read");
    expect(target.querySelector('[data-testid="brief-rise-icon-claude"]')).not.toBeNull();
  });
});
