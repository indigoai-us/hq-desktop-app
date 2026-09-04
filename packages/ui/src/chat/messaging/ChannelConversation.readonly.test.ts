// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountWith(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages: [], ...props },
  });
  return host;
}

describe("ChannelConversation read-only (system sender)", () => {
  it("replaces the composer with a notice when readOnly", async () => {
    const root = mountWith({ readOnly: true });
    await tick();
    expect(
      root.querySelector('[data-testid="conversation-composer"]'),
    ).toBeNull();
    expect(root.querySelector('[data-testid="composer-send"]')).toBeNull();
    const notice = root.querySelector('[data-testid="composer-readonly"]');
    expect(notice?.textContent).toContain("automated HQ notification");
  });

  it("uses a custom notice when provided", async () => {
    const root = mountWith({ readOnly: true, readOnlyNotice: "Nobody home." });
    await tick();
    expect(
      root.querySelector('[data-testid="composer-readonly"]')?.textContent,
    ).toContain("Nobody home.");
  });

  it("renders the normal composer by default", async () => {
    const root = mountWith({});
    await tick();
    expect(
      root.querySelector('[data-testid="conversation-composer"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-testid="composer-readonly"]')).toBeNull();
  });
});
