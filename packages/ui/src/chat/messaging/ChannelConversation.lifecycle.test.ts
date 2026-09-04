// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { LifecycleCardActionEvent } from "./channelMessageModels.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const envelope = {
  v: 1,
  type: "lifecycle_card",
  cardId: "card_create_1",
  kind: "create_company",
  companyUid: null,
  state: "open",
  title: "Name your company",
  fields: [
    {
      id: "name",
      label: "Company name",
      control: "text",
      required: true,
      value: "Ramen Bae",
    },
  ],
  actions: [{ id: "submit", label: "Create", style: "primary" }],
  viewer: { canAct: true },
};

function mountThread(
  systemEvent: unknown,
  extra: Record<string, unknown> = {},
): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      channelId: "setup",
      messages: [
        {
          eventId: "evt_card",
          direction: "in",
          fromDisplayName: "HQ",
          fromPersonUid: "agt_hq",
          body: "",
          createdAt: "2026-09-02T14:12:00.000Z",
          messageKind: "system",
          systemEvent,
        },
      ],
      ...extra,
    },
  });
  return host;
}

describe("ChannelConversation lifecycle cards", () => {
  it("mounts LifecycleCard for lifecycle_card events", async () => {
    const root = mountThread(envelope);
    await tick();
    expect(root.querySelector("[data-testid='lifecycle-card-row']")).not.toBeNull();
    expect(root.querySelector("[data-testid='lifecycle-card']")).not.toBeNull();
    expect(root.querySelector("[data-testid='lifecycle-card']")?.textContent).toContain(
      "Name your company",
    );
  });

  it("bubbles oncardaction with channelId, cardId, actionId, and values", async () => {
    const oncardaction = vi.fn();
    const root = mountThread(envelope, { oncardaction });
    await tick();
    root
      .querySelector<HTMLButtonElement>('[data-testid="lifecycle-action-submit"]')
      ?.click();
    flushSync();
    expect(oncardaction).toHaveBeenCalledTimes(1);
    const event = oncardaction.mock.calls[0][0] as LifecycleCardActionEvent;
    expect(event).toEqual({
      channelId: "setup",
      cardId: "card_create_1",
      actionId: "submit",
      values: { name: "Ramen Bae" },
    });
  });

  it("renders nothing for an unknown lifecycle_card version", async () => {
    const root = mountThread({ ...envelope, v: 2 });
    await tick();
    expect(root.querySelector("[data-testid='lifecycle-card']")).toBeNull();
    expect(root.querySelector("[data-testid='conversation-message']")).toBeNull();
  });

  it("puts actor and time on system lines", async () => {
    const root = mountThread({
      v: 1,
      type: "deploy",
      title: "Corey Epstein created Ramen Bae",
    });
    await tick();
    const line = root.querySelector("[data-testid='system-event-line']");
    expect(line?.textContent).toContain("HQ");
    expect(line?.textContent).toContain("Corey Epstein created Ramen Bae");
    expect(line?.querySelector(".sys-time")?.textContent).toMatch(/·/);
  });
});
