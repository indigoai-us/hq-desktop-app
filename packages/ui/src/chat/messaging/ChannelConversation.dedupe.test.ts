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

describe("ChannelConversation timeline eventId dedupe", () => {
  it("renders a duplicate eventId from the injected timeline once", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [
          {
            eventId: "evt_same",
            body: "first",
            createdAt: "2026-08-28T01:14:00.000Z",
            fromDisplayName: "Ada",
          },
          {
            eventId: "evt_same",
            body: "second",
            createdAt: "2026-08-28T01:15:00.000Z",
            fromDisplayName: "Ada",
          },
        ],
      },
    });
    await tick();
    const rows = [
      ...host.querySelectorAll('[data-testid="conversation-message"]'),
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("first");
    expect(rows[0]?.textContent).not.toContain("second");
  });
});
