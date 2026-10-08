// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

/**
 * US-009 AC0: the per-message action row that holds Reply and Copy has a
 * Forward button on 1:1 DMs, group DMs, and channels. All three hosts render
 * ChannelConversation; they differ by channelId and @here.
 */

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    eventId: id,
    fromPersonUid: "prs_1",
    fromDisplayName: "Ana",
    body: `hello ${id}`,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    ...extra,
  };
}

function mountWith(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, { target: host, props: { onreply: () => {}, ...props } as never });
}

const forwardButtons = () =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-testid="message-forward"]'));

describe("ChannelConversation Forward action (US-009)", () => {
  const hosts: Array<[string, Record<string, unknown>]> = [
    ["1:1 DM", { channelId: null, allowHereMention: false }],
    ["group DM", { channelId: "ch_group", allowHereMention: true }],
    ["channel", { channelId: "ch_team", allowHereMention: true }],
  ];

  for (const [label, extra] of hosts) {
    it(`sits in the Reply/Copy row on a ${label} and passes the message`, async () => {
      const forwarded: string[] = [];
      mountWith({ ...extra, messages: [message("evt_1")], onforward: (m: { eventId: string }) => forwarded.push(m.eventId) });
      await tick();
      const buttons = forwardButtons();
      expect(buttons).toHaveLength(1);
      const row = buttons[0].parentElement!;
      expect(row.querySelector('[data-testid="message-reply-quick"]')).not.toBeNull();
      expect(row.querySelector('[data-testid="message-copy"]')).not.toBeNull();
      expect(buttons[0].textContent?.trim()).toBe("Forward");
      buttons[0].click();
      expect(forwarded).toEqual(["evt_1"]);
    });
  }

  it("is not drawn when the host passes no onforward", async () => {
    mountWith({ messages: [message("evt_1")] });
    await tick();
    expect(forwardButtons()).toHaveLength(0);
  });

  it("is not drawn on an unsent row", async () => {
    mountWith({ messages: [message("local-send-0")], onforward: () => {} });
    await tick();
    expect(forwardButtons()).toHaveLength(0);
  });
});
