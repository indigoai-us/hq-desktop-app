// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function message(i: number) {
  return {
    eventId: `evt_${i}`,
    channelId: "setup",
    fromPersonUid: "prs_1",
    fromDisplayName: "HQ",
    body: `message ${i}`,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  };
}

const pill = () => host!.querySelector('[data-testid="conversation-jump-latest"]');

describe("ChannelConversation landAt", () => {
  it("lands at the top with no jump pill when the pane's point is its header", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({ messages: Array.from({ length: 12 }, (_, i) => message(i)), landAt: "top" as const });
    component = mount(ChannelConversation, { target: host, props });
    await tick();
    // The initial history landing is not "news": no pill on first paint.
    expect(pill()).toBeNull();
    // A later arrival is: the pill appears so nothing below is missed.
    props.messages = [...props.messages, message(12)];
    await tick();
    expect(pill()?.textContent).toContain("New messages");
  });

  it("still lands on the newest message for ordinary chat", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({ messages: Array.from({ length: 12 }, (_, i) => message(i)) });
    component = mount(ChannelConversation, { target: host, props });
    await tick();
    expect(pill()).toBeNull();
  });
});
