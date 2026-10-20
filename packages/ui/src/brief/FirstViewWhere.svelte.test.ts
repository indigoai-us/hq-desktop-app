// @vitest-environment happy-dom

/**
 * First view, "Where you work": one row per harness with its session count
 * and a bar scaled to the busiest one, and the harness's open action under
 * them. No orbit is drawn, and the open button waits while a launch is busy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstViewWhere from "./FirstViewWhere.svelte";
import type { FirstViewTool } from "./brief-first-view.js";
import type { WelcomeAction } from "./brief-welcome-contract.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const TOOLS: FirstViewTool[] = [
  { harness: "claude-code", name: "Claude Code", sessions: 120 },
  { harness: "codex", name: "Codex", sessions: 30 },
];
const OPEN: WelcomeAction = {
  id: "open-cc",
  kind: "open_harness",
  label: "Open Claude Code",
  reason: "",
  launch_prompt: "",
  primary: false,
  harness: "claude-code",
};

async function render(props: Record<string, unknown>): Promise<void> {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(FirstViewWhere, { target, props: props as never });
  await tick();
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe("FirstViewWhere", () => {
  it("lists each tool with its session count, in order, with bars scaled to the busiest", async () => {
    await render({ tools: TOOLS });
    const rows = [...target.querySelectorAll<HTMLElement>('[data-testid="first-view-where-row"]')];
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Claude Code 120", "Codex 30"]);
    const widths = rows.map((r) => r.querySelector<HTMLElement>(".fv-bar i")!.style.width);
    expect(widths).toEqual(["100%", "25%"]);
  });

  it("draws no orbit", async () => {
    await render({ tools: TOOLS, open: OPEN, onopen: () => {} });
    expect(target.querySelector('[class*="orbit"], [data-testid*="orbit"], svg circle')).toBeNull();
    expect(target.textContent).not.toMatch(/orbit/i);
  });

  it("the open button carries the action's label and calls onopen with that action", async () => {
    const onopen = vi.fn();
    await render({ tools: TOOLS, open: OPEN, onopen });
    const btn = target.querySelector<HTMLButtonElement>('[data-testid="first-view-where-open"]')!;
    expect(btn.textContent).toBe("Open Claude Code");
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(onopen).toHaveBeenCalledWith(OPEN);
  });

  it("while busy the open button is disabled and a click does nothing", async () => {
    const onopen = vi.fn();
    await render({ tools: TOOLS, open: OPEN, onopen, busy: true });
    const btn = target.querySelector<HTMLButtonElement>('[data-testid="first-view-where-open"]')!;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onopen).not.toHaveBeenCalled();
  });

  it("shows no open button without an action or without a handler", async () => {
    await render({ tools: TOOLS, open: null, onopen: () => {} });
    expect(target.querySelector("button")).toBeNull();
    unmount(component!);
    target.remove();
    await render({ tools: TOOLS, open: OPEN });
    expect(target.querySelector("button")).toBeNull();
  });
});
