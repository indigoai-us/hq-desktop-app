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
  origin: { companyUid: "indigo", repo: null },
  prompt: "Review PR 42 and leave comments.",
  detail: { why: "Launch is Friday", unlocks: [{ label: "Sam", state: "waiting since Monday" }], source: "prs" },
};

function render(destinations: BriefActionDestinations, over: Partial<{ runId: string | null; onassistant: (prompt: string, idempotencyKey: string) => Promise<string | null>; onlaunch: (engine: "claude" | "codex", prompt: string) => Promise<string | null> }> = {}) {
  const onassistant = vi.fn(async () => null);
  const onlaunch = vi.fn(async () => null);
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(BriefActionCard, {
    target,
    props: { card: actionCardData(DECISION)!, destinations, runId: "run-7", now: "2026-10-15T09:00:00", onassistant, onlaunch, ...over },
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
    expect(onassistant).toHaveBeenCalledWith("Review PR 42 and leave comments.", "brief-action:run-7:d1");
    expect(onlaunch).not.toHaveBeenCalled();
  });

  it("shows the note the send resolves to, so a sent item is distinguishable from nothing", async () => {
    render(ALL, { onassistant: async () => "Sent to Ada." });
    q('[data-testid="brief-action-assistant"]')!.click();
    await settle();
    expect(q('[role="status"]')?.textContent).toBe("Sent to Ada.");
  });

  it("shows the failure note when the send rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(ALL, { onassistant: () => Promise.reject(new Error("offline")) });
    q('[data-testid="brief-action-assistant"]')!.click();
    await settle();
    expect(q('[role="status"]')?.textContent).toBe("Could not send this to Ada. Try again in a moment.");
    expect((q('[data-testid="brief-action-assistant"]') as HTMLButtonElement).disabled).toBe(false);
    warn.mockRestore();
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

  it("keys a send by run and item, or by local day when the brief has no run id", () => {
    expect(assistantIdempotencyKey("run-7", "d1", "2026-10-15T09:00:00")).toBe("brief-action:run-7:d1");
    expect(assistantIdempotencyKey(null, "d1", "2026-10-15T09:00:00")).toBe("brief-action:day-2026-10-15:d1");
    // The same item on the next day's brief is a new send.
    expect(assistantIdempotencyKey(null, "d1", "2026-10-16T09:00:00")).toBe("brief-action:day-2026-10-16:d1");
  });

  it("keys a card's send by local day when the brief has no run id", async () => {
    const { onassistant } = render(ALL, { runId: null });
    q('[data-testid="brief-action-assistant"]')!.click();
    await settle();
    expect(onassistant).toHaveBeenCalledWith("Review PR 42 and leave comments.", "brief-action:day-2026-10-15:d1");
  });
});
