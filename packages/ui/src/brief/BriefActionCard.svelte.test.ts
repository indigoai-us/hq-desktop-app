// @vitest-environment happy-dom

/**
 * Report action cards: each card shows what the work is, why now and the
 * evidence, and one button per place it can be done. Each button does what it
 * says; a tool that is not installed has no button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import BriefActionCard from "./BriefActionCard.svelte";
import { actionCardData, assistantIdempotencyKey, type BriefActionDestinations } from "./brief-action-cards.js";
import type { BriefDecision } from "./brief-types.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = (sel: string): HTMLElement | null => target.querySelector<HTMLElement>(sel);

const DECISION: BriefDecision = {
  id: "d1",
  title: "Review the pricing page PR",
  summary: "Open for two days",
  action: "go",
  origin: { companyUid: "indigo", label: "Indigo" },
  prompt: "Review PR 42 and leave comments.",
  detail: { why: "Launch is Friday", unlocks: [{ label: "Sam", state: "waiting since Monday" }], source: "prs" },
};

function render(destinations: BriefActionDestinations, over: Partial<{ onassistant: unknown; onlaunch: unknown }> = {}) {
  const onassistant = vi.fn(async () => null);
  const onlaunch = vi.fn(async () => null);
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(BriefActionCard, {
    target,
    props: { card: actionCardData(DECISION)!, destinations, runId: "run-7", onassistant, onlaunch, ...over },
  });
  return { onassistant, onlaunch };
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

const ALL: BriefActionDestinations = { assistantName: "Ada", claudeCode: true, codex: true };

describe("BriefActionCard", () => {
  it("shows what it is, why now and the evidence", () => {
    render(ALL);
    expect(q("h3")?.textContent).toBe("Review the pricing page PR");
    expect(q('[data-testid="brief-action-why"]')?.textContent).toBe("Launch is Friday");
    expect(q('[data-testid="brief-action-evidence"]')?.textContent).toContain("Sam: waiting since Monday");
    expect(q('[data-testid="brief-action-evidence"]')?.textContent).toContain("prs");
  });

  it("labels the three buttons with the decided copy", () => {
    render(ALL);
    expect(q('[data-testid="brief-action-assistant"]')?.textContent).toBe("Do it with Ada");
    expect(q('[data-testid="brief-action-claude"]')?.textContent).toBe("Open in Claude Code");
    expect(q('[data-testid="brief-action-codex"]')?.textContent).toBe("Open in Codex");
  });

  it("sends the prompt to the assistant with an idempotency key", async () => {
    const { onassistant, onlaunch } = render(ALL);
    q('[data-testid="brief-action-assistant"]')!.click();
    await settle();
    expect(onassistant).toHaveBeenCalledWith("Review PR 42 and leave comments.", assistantIdempotencyKey("run-7", "d1"));
    expect(onlaunch).not.toHaveBeenCalled();
  });

  it("opens Claude Code and Codex with the prompt", async () => {
    const { onlaunch } = render(ALL);
    q('[data-testid="brief-action-claude"]')!.click();
    await settle();
    q('[data-testid="brief-action-codex"]')!.click();
    await settle();
    expect(onlaunch).toHaveBeenNthCalledWith(1, "claude", "Review PR 42 and leave comments.");
    expect(onlaunch).toHaveBeenNthCalledWith(2, "codex", "Review PR 42 and leave comments.");
  });

  it("leaves out the button of a tool that is not installed and the assistant button with no assistant", () => {
    render({ assistantName: null, claudeCode: false, codex: true });
    expect(q('[data-testid="brief-action-assistant"]')).toBeNull();
    expect(q('[data-testid="brief-action-claude"]')).toBeNull();
    expect(q('[data-testid="brief-action-codex"]')).not.toBeNull();
  });

  it("uses the run's prompt over the item's own, and skips items with no prompt", () => {
    expect(actionCardData(DECISION, { d1: "Run prompt" })?.prompt).toBe("Run prompt");
    expect(actionCardData({ ...DECISION, prompt: undefined })).toBeNull();
  });

  it("keys a send by run and item", () => {
    expect(assistantIdempotencyKey("run-7", "d1")).toBe(assistantIdempotencyKey("run-7", "d1"));
    expect(assistantIdempotencyKey("run-7", "d1")).not.toBe(assistantIdempotencyKey("run-8", "d1"));
  });
});
