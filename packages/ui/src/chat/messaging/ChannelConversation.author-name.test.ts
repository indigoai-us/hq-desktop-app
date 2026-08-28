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

const message = {
  eventId: "evt_1",
  direction: "in",
  fromPersonUid: "prs_yousuf",
  fromDisplayName: "Yousuf Kalim", // full name baked at send time
  body: "Hi",
  createdAt: "2026-08-28T01:14:00.000Z",
};

describe("ChannelConversation author name", () => {
  it("prefers the live roster display name over the baked message name", async () => {
    const root = mountWith({
      messages: [message],
      displayNameByUid: { prs_yousuf: "Yousuf" },
    });
    await tick();
    const author = root.querySelector(".dm-msg-author");
    expect(author?.textContent?.trim()).toBe("Yousuf");
  });

  it("falls back to the baked message name when the roster has none", async () => {
    const root = mountWith({ messages: [message], displayNameByUid: {} });
    await tick();
    const meta = root.querySelector(".dm-msg-author");
    expect(meta?.textContent?.trim()).toBe("Yousuf Kalim");
  });
});
