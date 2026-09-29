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

const MESH_BODY =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"T-002 marked done on the board"}}';

function mountWith(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [
        {
          eventId: "evt_mesh",
          direction: "in",
          fromDisplayName: "work-mesh",
          body: MESH_BODY,
          createdAt: "2026-08-28T15:14:05.000Z",
        },
        {
          eventId: "evt_human",
          direction: "in",
          fromDisplayName: "Ada",
          body: "hello there",
          createdAt: "2026-08-28T15:14:10.000Z",
        },
        {
          eventId: "evt_bot",
          direction: "in",
          fromDisplayName: "Izzy",
          fromPersonUid: "bot_izzy",
          audience: "bot",
          body: "an automated ping",
          createdAt: "2026-08-28T15:14:15.000Z",
        },
      ],
      ...props,
    },
  });
  return host;
}

describe("ChannelConversation human-only mode", () => {
  it("flag off: renders the work-mesh row and both other messages", async () => {
    const root = mountWith({ humanOnly: false });
    await tick();
    expect(root.querySelector(".work-mesh-row")).not.toBeNull();
    expect(root.textContent).toContain("hello there");
    expect(root.textContent).toContain("an automated ping");
  });

  it("flag on: hides work-mesh and bot-audience rows, keeps human message", async () => {
    const root = mountWith({ humanOnly: true });
    await tick();
    expect(root.querySelector(".work-mesh-row")).toBeNull();
    expect(root.textContent).toContain("hello there");
    expect(root.textContent).not.toContain("an automated ping");
  });
});
