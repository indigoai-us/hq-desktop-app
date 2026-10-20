// @vitest-environment happy-dom

/**
 * First view, "One thing": Core's primary action as a sentence, its reason
 * without zero counts, and one way to start it. A prompt action starts in the
 * brief's engine; an open or connect action runs through the host's onaction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import Harness from "./FirstViewOneThingHarness.test-support.svelte";
import type { WelcomeAction } from "./brief-welcome-contract.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function action(over: Partial<WelcomeAction> = {}): WelcomeAction {
  return {
    id: "a1",
    kind: "open_harness",
    label: "Pick up the billing refactor",
    reason: "You worked on it yesterday across 0 companies",
    launch_prompt: "",
    primary: true,
    harness: "claude-code",
    ...over,
  };
}

async function render(props: Record<string, unknown>): Promise<void> {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(Harness, { target, props: props as never });
  await settle();
}
const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe("FirstViewOneThing", () => {
  it("shows the label as a sentence and the reason without a zero count", async () => {
    await render({ action: action() });
    expect(q("first-view-one-thing-quote")!.textContent).toBe("Pick up the billing refactor.");
    expect(target.querySelector(".because")!.textContent).toBe("You worked on it yesterday");
    expect(target.textContent).not.toMatch(/\b0 companies\b/);
  });

  it("an open action shows the host's button label and calls onaction with the action", async () => {
    const onaction = vi.fn();
    const a = action();
    await render({ action: a, onaction, actionLabel: "Open Claude Code" });
    const btn = target.querySelector<HTMLButtonElement>(".go-row button")!;
    expect(btn.textContent).toBe("Open Claude Code");
    btn.click();
    expect(onaction).toHaveBeenCalledWith(a);
    expect(q("brief-launch")).toBeNull();
  });

  it("the open button is disabled and marked busy while the open is pending, and enabled again after", async () => {
    const onaction = vi.fn();
    await render({ action: action(), onaction, actionLabel: "Open Claude Code", busy: true });
    const btn = target.querySelector<HTMLButtonElement>(".go-row button")!;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    btn.click();
    expect(onaction).not.toHaveBeenCalled();
    unmount(component!);
    target.remove();
    await render({ action: action(), onaction, actionLabel: "Open Claude Code", busy: false });
    const again = target.querySelector<HTMLButtonElement>(".go-row button")!;
    expect(again.disabled).toBe(false);
    expect(again.getAttribute("aria-busy")).toBe("false");
  });

  it("a connect action runs through onaction, not the engine", async () => {
    const onaction = vi.fn();
    const onlaunch = vi.fn(async () => null);
    await render({ action: action({ kind: "connect_ai_apps", launch_prompt: "connect things" }), onaction, actionLabel: "Connect", onlaunch });
    expect(q("brief-launch")).toBeNull();
    target.querySelector<HTMLButtonElement>(".go-row button")!.click();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onlaunch).not.toHaveBeenCalled();
  });

  it("a prompt action starts its prompt in the brief's engine and shows the note", async () => {
    const onlaunch = vi.fn(async () => null);
    await render({ action: action({ kind: "open_tree", launch_prompt: "Review the billing refactor" }), onlaunch });
    q("brief-start")!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledWith(expect.any(String), "Review the billing refactor");
    expect(target.querySelector('[role="status"]')!.textContent).toMatch(/^Started in /);
  });

  it("an open action with no handler shows no button and no empty go row text", async () => {
    await render({ action: action({ reason: "" }) });
    expect(target.querySelector("button")).toBeNull();
    expect(target.querySelector(".because")).toBeNull();
    expect(target.querySelector(".go-row")!.textContent!.trim()).toBe("");
  });
});
