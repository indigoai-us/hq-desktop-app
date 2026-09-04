// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import { MARKETPLACE_COVER_HOST } from "../../avatars/csp-image-src";
import ChannelConversation from "./ChannelConversation.svelte";
import { agentAvatarAssets } from "./agent-avatars";

const AGENT_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/agt_photo/h.png?X-Amz-Signature=mock`;
const ADA_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_h/h.png?X-Amz-Signature=mock`;
const SELF_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_me/h.png?X-Amz-Signature=mock`;

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

const messages = [
  {
    eventId: "evt_photo",
    direction: "in",
    fromPersonUid: "agt_photo",
    fromDisplayName: "Photo Agent",
    body: "photo hello",
    createdAt: "2026-08-28T01:14:00.000Z",
  },
  {
    eventId: "evt_plain",
    direction: "in",
    fromPersonUid: "agt_plain",
    fromDisplayName: "Plain Agent",
    body: "plain hello",
    createdAt: "2026-08-28T01:15:00.000Z",
  },
  {
    eventId: "evt_human",
    direction: "in",
    fromPersonUid: "prs_h",
    fromDisplayName: "Ada Lovelace",
    body: "human hello",
    createdAt: "2026-08-28T01:16:00.000Z",
  },
];

describe("ChannelConversation message avatars", () => {
  it("renders photo, generated, and initials avatars on group-start rows", async () => {
    const root = mountWith({
      messages,
      avatarByUid: { agt_photo: AGENT_PHOTO },
    });
    await tick();

    const avatars = [...root.querySelectorAll(".dm-msg-avatar")];
    expect(avatars).toHaveLength(3);

    expect(avatars[0]?.querySelector("img.avatar-img")?.getAttribute("src")).toBe(
      AGENT_PHOTO,
    );

    const generatedSrc = avatars[1]
      ?.querySelector("img.avatar-img")
      ?.getAttribute("src");
    expect(agentAvatarAssets).toContain(generatedSrc);

    expect(avatars[2]?.querySelector(".monogram")?.textContent).toBe("AL");
    expect(avatars[2]?.querySelector("img")).toBeNull();

    expect(root.querySelector(".agent-glyph")).toBeNull();
  });

  it("renders a roster photo for a human author", async () => {
    const root = mountWith({
      messages: [messages[2]],
      avatarByUid: { prs_h: ADA_PHOTO },
    });
    await tick();
    const avatar = root.querySelector(".dm-msg-avatar");
    expect(avatar?.querySelector("img.avatar-img")?.getAttribute("src")).toBe(
      ADA_PHOTO,
    );
    expect(avatar?.querySelector(".monogram")).toBeNull();
  });

  it("renders the signed-in user's own photo on their messages", async () => {
    const root = mountWith({
      messages: [
        {
          eventId: "evt_self",
          direction: "out",
          fromPersonUid: "prs_me",
          fromDisplayName: "Corey",
          body: "mine",
          createdAt: "2026-08-28T01:17:00.000Z",
        },
      ],
      selfPersonUid: "prs_me",
      avatarByUid: { prs_me: SELF_PHOTO },
    });
    await tick();
    expect(
      root.querySelector(".dm-msg-avatar img.avatar-img")?.getAttribute("src"),
    ).toBe(SELF_PHOTO);
  });

  it("does not paint an arbitrary https roster URL (packaged CSP contract)", async () => {
    const root = mountWith({
      messages: [messages[2]],
      avatarByUid: { prs_h: "https://cdn.test/ada.jpg" },
    });
    await tick();
    const avatar = root.querySelector(".dm-msg-avatar");
    expect(avatar?.querySelector("img")).toBeNull();
    expect(avatar?.querySelector(".monogram")?.textContent).toBe("AL");
  });
});
