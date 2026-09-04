// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import { MARKETPLACE_COVER_HOST } from "../../avatars/csp-image-src";
import ChannelConversation from "./ChannelConversation.svelte";

const ADA_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_h/h.png?X-Amz-Signature=mock`;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("ChannelConversation message avatars (reactive roster)", () => {
  it("updates a human row when the roster photo arrives after first render", async () => {
    const props = $state({
      messages: [
        {
          eventId: "evt_human",
          direction: "in",
          fromPersonUid: "prs_h",
          fromDisplayName: "Ada Lovelace",
          body: "human hello",
          createdAt: "2026-08-28T01:16:00.000Z",
        },
      ],
      avatarByUid: {} as Record<string, string>,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, { target: host, props });
    await tick();
    expect(host.querySelector(".dm-msg-avatar .monogram")?.textContent).toBe(
      "AL",
    );
    expect(host.querySelector(".dm-msg-avatar img")).toBeNull();

    props.avatarByUid = { prs_h: ADA_PHOTO };
    await tick();
    expect(
      host.querySelector(".dm-msg-avatar img.avatar-img")?.getAttribute("src"),
    ).toBe(ADA_PHOTO);
    expect(host.querySelector(".dm-msg-avatar .monogram")).toBeNull();
  });
});
