// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("ChannelConversation body links", () => {
  it("opens a bare URL via onopenurl and prevents default navigation", async () => {
    const onopenurl = vi.fn();
    const root = mountWith({
      messages: [
        {
          eventId: "evt_link",
          direction: "in",
          fromPersonUid: "prs_ada",
          fromDisplayName: "Ada",
          body: "see https://example.com/docs",
          createdAt: "2026-08-28T01:14:00.000Z",
        },
      ],
      onopenurl,
    });
    await tick();
    const anchor = root.querySelector(
      ".dm-bubble-body a[href]",
    ) as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("https://example.com/docs");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const propagated = anchor!.dispatchEvent(event);
    await tick();

    expect(onopenurl).toHaveBeenCalledTimes(1);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/docs");
    expect(event.defaultPrevented).toBe(true);
    expect(propagated).toBe(false);
  });
});
