// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const agentMsg = (eventId: string, body: string) => ({
  eventId,
  direction: "in" as const,
  fromPersonUid: "agt_helper",
  fromDisplayName: "Helper agent",
  participantType: "agent",
  body,
  createdAt: "2026-10-02T12:00:00.000Z",
});

function bodyFor(eventId: string): HTMLElement | null {
  return host.querySelector(`[data-event-id="${eventId}"] .dm-bubble-body`);
}

describe("ChannelConversation bot reply reveal", () => {
  it("does not reveal a human message that arrives live", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({
      messages: [agentMsg("evt_history", "Earlier reply.")],
      conversationKey: "dm:helper",
    });
    component = mount(ChannelConversation, { target: host, props });
    await tick();
    props.messages = [
      ...props.messages,
      {
        eventId: "evt_human",
        direction: "in" as const,
        fromPersonUid: "prs_stefan",
        fromDisplayName: "Stefan Johnson",
        participantType: "human",
        body: "Human message.",
        createdAt: "2026-10-02T12:01:00.000Z",
      },
    ];
    flushSync();
    await tick();
    expect(bodyFor("evt_human")?.dataset.reveal).toBeUndefined();
  });

  it("reveals a newly arrived bot reply line by line but renders history instantly", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({
      messages: [agentMsg("evt_history", "Earlier reply from history.")],
      conversationKey: "dm:helper",
    });
    component = mount(ChannelConversation, { target: host, props });
    await tick();

    expect(bodyFor("evt_history")?.dataset.reveal).toBeUndefined();
    expect(bodyFor("evt_history")?.querySelector(".reveal-line")).toBeNull();

    props.messages = [
      ...props.messages,
      agentMsg("evt_new", "A fresh reply that just landed.\n\nSecond line."),
    ];
    flushSync();
    await tick();

    const fresh = bodyFor("evt_new");
    expect(fresh?.dataset.reveal).toBe("true");
    expect(fresh?.querySelectorAll(".reveal-line").length).toBe(2);
    expect(fresh?.textContent).toContain("A fresh reply that just landed.");
    expect(bodyFor("evt_history")?.dataset.reveal).toBeUndefined();
  });
});
