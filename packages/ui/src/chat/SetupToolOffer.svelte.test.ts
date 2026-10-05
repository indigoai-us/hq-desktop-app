// @vitest-environment happy-dom

// SetupToolOffer is the card under the setup bot's first message when the
// person already uses the Claude or Codex app a lot. Contract: it names the app
// on the primary button, offers "Keep going here" as the second action, and
// hands both clicks back to the host.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import SetupToolOffer from "./SetupToolOffer.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown> = {}) {
  const handlers = { oncontinue: vi.fn(), onkeep: vi.fn() };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupToolOffer, { target: host, props: { tool: "claude", ...handlers, ...props } as never });
  flushSync();
  return { host, ...handlers };
}

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe("SetupToolOffer", () => {
  it("offers the Claude app as the primary action and keeping setup here as the second", () => {
    const { host, oncontinue, onkeep } = render();
    expect(q(host, "setup-tool-offer-continue")!.textContent?.trim()).toBe("Continue in Claude");
    expect(q(host, "setup-tool-offer-keep")!.textContent?.trim()).toBe("Keep going here");
    q(host, "setup-tool-offer-continue")!.click();
    expect(oncontinue).toHaveBeenCalledOnce();
    expect(onkeep).not.toHaveBeenCalled();
    q(host, "setup-tool-offer-keep")!.click();
    expect(onkeep).toHaveBeenCalledOnce();
  });

  it("names Codex when the bot offered Codex", () => {
    const { host } = render({ tool: "codex" });
    expect(q(host, "setup-tool-offer-continue")!.textContent?.trim()).toBe("Continue in Codex");
    expect(host.querySelector('[data-testid="setup-tool-offer"]')!.getAttribute("data-tool")).toBe("codex");
  });

  it("holds both buttons while a launch is in progress", () => {
    const { host, oncontinue } = render({ busy: true });
    expect(q(host, "setup-tool-offer-continue")!.disabled).toBe(true);
    expect(q(host, "setup-tool-offer-keep")!.disabled).toBe(true);
    q(host, "setup-tool-offer-continue")!.click();
    expect(oncontinue).not.toHaveBeenCalled();
  });

  it("shows a launch failure in plain words, and nothing when there is none", () => {
    const quiet = render();
    expect(q(quiet.host, "setup-tool-offer-error")).toBeNull();
    const failed = render({ launchError: "Couldn't open the Claude app from here." });
    expect(failed.host.querySelector('[data-testid="setup-tool-offer-error"]')!.textContent).toBe("Couldn't open the Claude app from here.");
  });

  it("never asks the person to type a command", () => {
    for (const tool of ["claude", "codex"]) {
      const { host } = render({ tool });
      expect(host.textContent).not.toMatch(/(^|\s)\/[a-z]/);
    }
  });
});
