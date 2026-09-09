// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import FirstMoves from "./FirstMoves.svelte";
import { firstMovesFor } from "./first-moves";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstMoves, { target: host, props: props as never });
  flushSync();
  return host;
}

describe("FirstMoves", () => {
  it("renders one expanded move with one primary button; the rest are one-liners", () => {
    const moves = firstMovesFor({ hasCompany: true, hasProjectChannel: false, done: new Set() });
    const el = render({ moves, onmove: vi.fn() });
    expect(el.querySelectorAll('[data-testid^="first-move-"][data-state]')).toHaveLength(4);
    expect(el.querySelectorAll(".btn.primary")).toHaveLength(1);
    expect(el.querySelector('[data-testid="first-move-action-project-channel"]')?.textContent).toContain(
      "New project channel",
    );
    expect(el.querySelector('[data-testid="first-move-invite"]')?.querySelector(".body")).toBeNull();
    expect(el.querySelector('[data-testid="first-moves-count"]')?.textContent).toBe("0 of 4");
  });

  it("reports the click and shows a plain failure reason inline", async () => {
    const moves = firstMovesFor({ hasCompany: true, hasProjectChannel: true, done: new Set() });
    const onmove = vi.fn(async () => "Could not open invitations.");
    const el = render({ moves, onmove });
    el.querySelector<HTMLButtonElement>('[data-testid="first-move-action-invite"]')!.click();
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="first-move-error-invite"]')?.textContent).toContain(
        "Could not open invitations.",
      );
    });
    expect(onmove).toHaveBeenCalledWith("invite");
  });

  it("offers Codex beside Claude Code on the coding-tools move", () => {
    const moves = firstMovesFor({
      hasCompany: true,
      hasProjectChannel: true,
      done: new Set(["invite", "agent"]),
    });
    const oncodex = vi.fn();
    const el = render({ moves, onmove: vi.fn(), oncodex });
    expect(el.querySelector('[data-testid="first-move-action-coding-tools"]')?.textContent).toContain(
      "Open in Claude Code",
    );
    el.querySelector<HTMLButtonElement>('[data-testid="first-move-action-codex"]')!.click();
    expect(oncodex).toHaveBeenCalledOnce();
  });

  it("renders nothing when there are no moves", () => {
    const el = render({ moves: [], onmove: vi.fn() });
    expect(el.querySelector('[data-testid="first-moves"]')).toBeNull();
  });
});
