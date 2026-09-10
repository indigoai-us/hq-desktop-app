// @vitest-environment happy-dom

// SetupFinale is the one block under the Setup Agent's last message once
// the run is done. Contract: the "Continue in …" actions keep their
// testids (the shell tests select on them), the Sessions button only shows
// with a handler, Learn-HQ links go through the host (never the webview),
// and the bottom row opens the company channel and fires Run again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import SetupFinale from "./SetupFinale.svelte";
import { SETUP_RESOURCES } from "./setup-channel";

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
    expect(root?.getAttribute("aria-label")).toBe("You're set up.");
    expect(el.querySelector('[data-testid="setup-finale-title"]')?.textContent).toBe("You're set up.");
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

  it("opens the company channel from the bottom row as a secondary button, and hides it when null", () => {
    const onopen = vi.fn();
    const el = render({ company: { label: "Open Acme", onopen } });
    const open = el.querySelector<HTMLButtonElement>('[data-testid="setup-finale-open-company"]');
    expect(open?.textContent?.trim()).toBe("Open Acme");
    expect(open?.getAttribute("data-variant")).toBe("secondary");
    // No "Open setup chat" in the finale any more: the company channel is the way on.
    expect(el.querySelector('[data-testid="setup-run-details"]')).toBeNull();
    expect(el.textContent).not.toContain("Open setup chat");
    open!.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    const none = render({ company: null });
    expect(none.querySelector('[data-testid="setup-finale-open-company"]')).toBeNull();
  });

  it("fires Run again next to the company button, and hides it without a handler", () => {
    const onrunagain = vi.fn();
    const onopen = vi.fn();
    const el = render({ onrunagain, company: { label: "Continue setup for Acme", onopen } });
    const again = el.querySelector<HTMLButtonElement>('[data-testid="setup-run-again"]');
    expect(again?.textContent?.trim()).toBe("Run again");
    expect(again?.getAttribute("data-variant")).toBe("quiet");
    // Same row, company first.
    const open = el.querySelector<HTMLButtonElement>('[data-testid="setup-finale-open-company"]');
    expect(open?.parentElement).toBe(again?.parentElement);
    expect(open!.compareDocumentPosition(again!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    again!.click();
    expect(onrunagain).toHaveBeenCalledTimes(1);
    expect(onopen).not.toHaveBeenCalled();

    const bare = render();
    expect(bare.querySelector('[data-testid="setup-run-again"]')).toBeNull();
    expect(bare.querySelector('[data-testid="setup-finale-open-company"]')).toBeNull();
  });

  it("shows a launch error under the actions as an alert", () => {
    const el = render({ launchError: "Claude Code is not installed." });
    const error = el.querySelector('[data-testid="setup-finale-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe("Claude Code is not installed.");
    expect(render().querySelector('[data-testid="setup-finale-error"]')).toBeNull();
  });
});
