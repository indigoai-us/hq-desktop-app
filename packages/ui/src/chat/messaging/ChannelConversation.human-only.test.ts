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

  it("default-on: hides noted, started and completed rows and bot audience, keeps human and bot replies with audience both", async () => {
    const event = (kind: string, summary: string) =>
      JSON.stringify({
        v: 1,
        kind: "work-session-event",
        threadId: "work-desktop-dogfood:T-003",
        event: { kind, at: "2026-08-28T15:14:05.854Z", by: "Stefan Johnson", summary },
      });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          { eventId: "e_note", direction: "in", fromDisplayName: "Stefan Johnson", body: event("note", "noted-summary-xyz"), createdAt: "2026-08-28T15:14:01.000Z" },
          { eventId: "e_start", direction: "in", fromDisplayName: "Stefan Johnson", body: event("start", "started-summary-xyz"), createdAt: "2026-08-28T15:14:02.000Z" },
          { eventId: "e_done", direction: "in", fromDisplayName: "work-mesh", systemEvent: { v: 1, type: "run_complete", title: "completed-line-xyz" }, body: "", createdAt: "2026-08-28T15:14:03.000Z" },
          { eventId: "e_botaud", direction: "in", fromDisplayName: "Izzy", fromPersonUid: "bot_izzy", audience: "bot", body: "bot-audience-xyz", createdAt: "2026-08-28T15:14:04.000Z" },
          { eventId: "e_human", direction: "in", fromDisplayName: "Ada", audience: "human", body: "human-hello-xyz", createdAt: "2026-08-28T15:14:05.000Z" },
          { eventId: "e_both", direction: "in", fromDisplayName: "Izzy", fromPersonUid: "bot_izzy", audience: "both", body: "bot-reply-both-xyz", createdAt: "2026-08-28T15:14:06.000Z" },
        ],
      },
    });
    await tick();
    const text = host.textContent ?? "";
    expect(host.querySelector(".work-mesh-row")).toBeNull();
    expect(text).not.toContain("noted-summary-xyz");
    expect(text).not.toContain("started-summary-xyz");
    expect(text).not.toContain("completed-line-xyz");
    expect(text).not.toContain("bot-audience-xyz");
    expect(text).toContain("human-hello-xyz");
    expect(text).toContain("bot-reply-both-xyz");
  });

  it("default-on: a channel with only non-human rows shows the empty state", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          { eventId: "evt_mesh", direction: "in", fromDisplayName: "Stefan Johnson", body: MESH_BODY, createdAt: "2026-08-28T15:14:05.000Z" },
          { eventId: "e_sys", direction: "in", fromDisplayName: "work-mesh", systemEvent: { v: 1, type: "run_complete", title: "done" }, body: "", createdAt: "2026-08-28T15:14:06.000Z" },
        ],
      },
    });
    await tick();
    expect(host.querySelector('[data-testid="conversation-empty"]')).not.toBeNull();
    expect(host.querySelector(".work-mesh-row")).toBeNull();
  });

  it("default-on: keeps untagged agent replies and actionable lifecycle cards", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        humanOnly: true,
        messages: [
          { eventId: "e_agent", direction: "in", fromDisplayName: "Izzy", fromPersonUid: "agt_izzy", body: "agent-reply-untagged-xyz", createdAt: "2026-08-28T15:14:01.000Z" },
          {
            eventId: "e_card",
            direction: "in",
            fromDisplayName: "HQ",
            body: "",
            createdAt: "2026-08-28T15:14:02.000Z",
            systemEvent: {
              v: 1,
              type: "lifecycle_card",
              cardId: "card_create_1",
              kind: "create_company",
              companyUid: null,
              state: "open",
              title: "Name your company",
              fields: [{ id: "name", label: "Company name", control: "text", required: true, value: "" }],
              actions: [{ id: "submit", label: "Create", style: "primary" }],
              viewer: { canAct: true },
            },
          },
        ],
      },
    });
    await tick();
    expect(host.textContent).toContain("agent-reply-untagged-xyz");
    expect(host.querySelector('[data-testid="lifecycle-card"]')).not.toBeNull();
  });
});
