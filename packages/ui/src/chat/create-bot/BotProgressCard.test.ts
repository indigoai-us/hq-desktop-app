// @vitest-environment happy-dom

/**
 * The progress card a new Local bot's DM shows until it is online:
 * Creating identity → Installing on this Mac → Online. A failure freezes the
 * step it died on, shows the CLI's own reason, and offers one Retry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import BotProgressCard, { type BotProgressState } from "./BotProgressCard.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(props: { phase: BotProgressState } & Record<string, unknown>): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BotProgressCard, { target: host, props: { name: "scout", ...props } });
}

function stepStates(): Array<string | null> {
  return ["creating", "installing", "online"].map(
    (id) => host.querySelector(`[data-testid="bot-progress-step-${id}"]`)?.getAttribute("data-step-state") ?? null,
  );
}

describe("BotProgressCard", () => {
  it("ticks the steps off as the bot goes creating → installing → online", async () => {
    const seen: Array<{ state: BotProgressState; steps: Array<string | null>; title: string }> = [];
    for (const state of ["creating", "installing", "online"] as const) {
      render({ phase: state });
      await tick();
      seen.push({
        state,
        steps: stepStates(),
        title: host.querySelector('[data-testid="bot-progress-card"]')?.textContent ?? "",
      });
      if (component) await unmount(component);
      component = null;
      host.remove();
    }
    expect(seen[0]!.steps).toEqual(["active", "todo", "todo"]);
    expect(seen[1]!.steps).toEqual(["done", "active", "todo"]);
    expect(seen[2]!.steps).toEqual(["done", "done", "done"]);
    expect(seen[0]!.title).toContain("Setting up scout");
    expect(seen[2]!.title).toContain("scout is online");
    // Only the in-flight states promise a wait.
    expect(seen[1]!.title).toContain("About half a minute");
    expect(seen[2]!.title).not.toContain("About half a minute");
  });

  it("is a polite live region so the DM announces the bot coming online", async () => {
    render({ phase: "installing" });
    await tick();
    const card = host.querySelector('[data-testid="bot-progress-card"]');
    expect(card?.getAttribute("role")).toBe("status");
    expect(card?.getAttribute("aria-live")).toBe("polite");
    expect(card?.getAttribute("data-state")).toBe("installing");
  });

  it("a failure freezes the step, shows the CLI's reason, and Retry calls back", async () => {
    const onretry = vi.fn();
    render({
      phase: "failed",
      reason: "Claude Code is not signed in — sign in and retry.",
      onretry,
    });
    await tick();
    expect(stepStates()).toEqual(["done", "failed", "todo"]);
    expect(host.querySelector('[data-testid="bot-progress-card"]')?.textContent).toContain(
      "scout could not start",
    );
    expect(host.querySelector('[data-testid="bot-progress-reason"]')?.textContent).toContain(
      "Claude Code is not signed in",
    );
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="bot-progress-retry"]');
    expect(retry).toBeTruthy();
    retry!.click();
    expect(onretry).toHaveBeenCalledTimes(1);
  });

  it("falls back to a plain reason and disables Retry while it runs", async () => {
    render({ phase: "failed", reason: null, onretry: vi.fn(), retrying: true });
    await tick();
    expect(host.querySelector('[data-testid="bot-progress-reason"]')?.textContent).toContain(
      "Something went wrong",
    );
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="bot-progress-retry"]');
    expect(retry?.disabled).toBe(true);
    expect(retry?.textContent).toContain("Retrying");
  });

  it("offers no Retry when the host cannot re-run the create", async () => {
    render({ phase: "failed", reason: "No." });
    await tick();
    expect(host.querySelector('[data-testid="bot-progress-retry"]')).toBeNull();
  });
});
