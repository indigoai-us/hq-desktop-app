// @vitest-environment happy-dom

// SetupFinale is the one block under the Setup Agent's last message once
// the run is done. Contract: the "Continue in …" actions keep their
// testids (the shell tests select on them), the Sessions button only shows
// with a handler, Learn-HQ links go through the host (never the webview),
// the quiet row fires its callbacks, and First Moves render inside it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import SetupFinale from "./SetupFinale.svelte";
import { SETUP_RESOURCES } from "./setup-channel";
import { firstMovesFor } from "./first-moves";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown> = {}): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupFinale, {
    target: host,
    props: { onclaude: vi.fn(), oncodex: vi.fn(), ...props } as never,
  });
  flushSync();
  return host;
}

describe("SetupFinale", () => {
  it("renders the title and the three Continue actions with the shell's testids", () => {
    const onsessions = vi.fn();
    const onclaude = vi.fn();
    const oncodex = vi.fn();
    const el = render({ onsessions, onclaude, oncodex });
    const root = el.querySelector('[data-testid="setup-agent-finish"]');
    expect(root?.getAttribute("role")).toBe("group");
    expect(root?.getAttribute("aria-label")).toBe("You're set up");
    expect(el.querySelector('[data-testid="setup-finale-title"]')?.textContent).toBe("You're set up");
    expect(el.textContent).toContain("Pick where to keep going");
    const sessions = el.querySelector<HTMLButtonElement>('[data-testid="setup-agent-open-sessions"]');
    const claude = el.querySelector<HTMLButtonElement>('[data-testid="setup-agent-open-claude"]');
    const codex = el.querySelector<HTMLButtonElement>('[data-testid="setup-agent-open-codex"]');
    expect(sessions?.textContent?.trim()).toBe("Continue in HQ Sessions");
    expect(claude?.textContent?.trim()).toBe("Continue in Claude Code");
    expect(codex?.textContent?.trim()).toBe("Continue in Codex");
    for (const button of [sessions, claude, codex]) expect(button?.getAttribute("data-variant")).toBe("primary");
    sessions!.click();
    claude!.click();
    codex!.click();
    expect(onsessions).toHaveBeenCalledTimes(1);
    expect(onclaude).toHaveBeenCalledTimes(1);
    expect(oncodex).toHaveBeenCalledTimes(1);
  });

  it("hides the Sessions button without a handler", () => {
    const el = render();
    expect(el.querySelector('[data-testid="setup-agent-open-sessions"]')).toBeNull();
    expect(el.querySelector('[data-testid="setup-agent-open-claude"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="setup-agent-open-codex"]')).toBeTruthy();
  });

  it("lists every Learn-HQ resource and opens it through the host, never the webview", () => {
    const onopenurl = vi.fn();
    const el = render({ onopenurl });
    const links = el.querySelectorAll<HTMLAnchorElement>('[data-testid^="setup-finale-resource-"]');
    expect(links).toHaveLength(SETUP_RESOURCES.length);
    const first = SETUP_RESOURCES[0]!;
    const link = el.querySelector<HTMLAnchorElement>(`[data-testid="setup-finale-resource-${first.id}"]`);
    expect(link?.getAttribute("href")).toBe(first.href);
    expect(link?.textContent?.trim()).toBe(first.title);
    expect(link?.textContent).not.toContain(first.description);
    expect(link?.querySelector("svg")).toBeTruthy();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onopenurl).toHaveBeenCalledWith(first.href);
  });

  it("fires Run again and Open setup chat, and hides them without handlers", () => {
    const onrunagain = vi.fn();
    const onshowdetails = vi.fn();
    const el = render({ onrunagain, onshowdetails });
    const again = el.querySelector<HTMLButtonElement>('[data-testid="setup-run-again"]');
    const details = el.querySelector<HTMLButtonElement>('[data-testid="setup-run-details"]');
    expect(again?.textContent?.trim()).toBe("Run again");
    expect(again?.getAttribute("data-variant")).toBe("quiet");
    expect(details?.textContent?.trim()).toBe("Open setup chat");
    expect(details?.getAttribute("data-variant")).toBe("quiet");
    again!.click();
    details!.click();
    expect(onrunagain).toHaveBeenCalledTimes(1);
    expect(onshowdetails).toHaveBeenCalledTimes(1);

    const bare = render();
    expect(bare.querySelector('[data-testid="setup-run-again"]')).toBeNull();
    expect(bare.querySelector('[data-testid="setup-run-details"]')).toBeNull();
  });

  it("renders the first moves inside the finale and routes their clicks", async () => {
    const moves = firstMovesFor({ hasCompany: true, hasProjectChannel: true, done: new Set() });
    const onmove = vi.fn(async () => null);
    const el = render({ firstMoves: moves, onmove });
    const list = el.querySelector('[data-testid="setup-agent-finish"] [data-testid="first-moves"]');
    expect(list).toBeTruthy();
    expect(list?.querySelectorAll('[data-testid^="first-move-"][data-state]')).toHaveLength(moves.length);
    el.querySelector<HTMLButtonElement>('[data-testid="first-move-action-invite"]')!.click();
    await Promise.resolve();
    expect(onmove).toHaveBeenCalledWith("invite");

    const empty = render({ firstMoves: [], onmove });
    expect(empty.querySelector('[data-testid="first-moves"]')).toBeNull();
  });

  it("shows a launch error under the actions as an alert", () => {
    const el = render({ launchError: "Claude Code is not installed." });
    const error = el.querySelector('[data-testid="setup-finale-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe("Claude Code is not installed.");
    expect(render().querySelector('[data-testid="setup-finale-error"]')).toBeNull();
  });
});
