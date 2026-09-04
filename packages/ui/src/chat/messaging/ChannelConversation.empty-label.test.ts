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

function mountEmpty(props: Record<string, unknown> = {}): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages: [], ...props },
  });
  return host;
}

function emptyText(root: HTMLDivElement): string {
  return (
    root.querySelector('[data-testid="conversation-empty"]')?.textContent ?? ""
  ).trim();
}

describe("ChannelConversation empty state", () => {
  it("still says 'No messages yet' by default", async () => {
    const root = mountEmpty();
    await tick();
    expect(emptyText(root)).toBe("No messages yet");
  });

  it("says 'No activity yet' when the host asks for it", async () => {
    // A project channel with zero chat AND zero work-mesh events is empty of
    // activity — "No messages yet" told the owner the wrong thing.
    const root = mountEmpty({ emptyLabel: "No activity yet" });
    await tick();
    expect(emptyText(root)).toBe("No activity yet");
  });

  it("shows no empty state at all while history is loading", async () => {
    const root = mountEmpty({ emptyLabel: "No activity yet", loading: true });
    await tick();
    expect(root.querySelector('[data-testid="conversation-empty"]')).toBeNull();
  });
});
