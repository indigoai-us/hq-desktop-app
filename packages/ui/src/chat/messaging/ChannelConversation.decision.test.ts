// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import { HQ_BLOCK_FENCE_LANG } from "./richMessageContent";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function cardBody(): string {
  const envelope = {
    v: 1,
    blocks: [
      {
        kind: "decision",
        question: "Approve this research and build plan?",
        options: [
          { id: "1", label: "Approve and build", recommended: true },
          { id: "2", label: "Revise the plan" },
        ],
        allowOther: true,
        questionId: "clarify_deacon_1",
      },
    ],
  };
  return [
    "Approve this research and build plan?",
    "",
    "```" + HQ_BLOCK_FENCE_LANG,
    JSON.stringify(envelope),
    "```",
  ].join("\n");
}

function mountWith(messages: ConversationMessageWire[]): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages },
  });
  return host;
}

describe("ChannelConversation — persisted decision selected state", () => {
  it("renders the card locked with the chosen option after a reload (answer already in the timeline)", async () => {
    // Simulates reopening the DM: the agent card AND the human's answer are both
    // already in the injected timeline — no click happens this session.
    const root = mountWith([
      {
        eventId: "evt_card",
        direction: "in" as const,
        fromPersonUid: "agt_deacon",
        fromDisplayName: "Deacon",
        body: cardBody(),
        createdAt: "2026-09-08T10:00:00.000Z",
      },
      {
        eventId: "evt_answer",
        direction: "out" as const,
        fromPersonUid: "usr_jacob",
        fromDisplayName: "Jacob",
        body: "Approve and build",
        createdAt: "2026-09-08T10:01:00.000Z",
      },
    ]);
    await tick();

    const card = root.querySelector('[data-testid="rich-decision"]');
    expect(card).not.toBeNull();

    // Every option button is locked.
    root
      .querySelectorAll<HTMLButtonElement>('[data-testid="rich-decision-option"]')
      .forEach((b) => expect(b.disabled).toBe(true));

    // The chosen option is highlighted with a check; the other is inactive.
    const options = root.querySelectorAll<HTMLButtonElement>(
      '[data-testid="rich-decision-option"]',
    );
    const chosen = [...options].find((b) => b.dataset.chosen === "true");
    expect(chosen?.textContent).toContain("Approve and build");
    expect(chosen?.querySelector(".rich-decision-check")).not.toBeNull();
    const other = [...options].find((b) => b.dataset.chosen !== "true");
    expect(other?.classList.contains("is-inactive")).toBe(true);

    expect(
      root.querySelector('[data-testid="rich-decision-answered"]')?.textContent,
    ).toContain("Approve and build");
  });

  it("leaves an unanswered card interactive", async () => {
    const root = mountWith([
      {
        eventId: "evt_card",
        direction: "in" as const,
        fromPersonUid: "agt_deacon",
        fromDisplayName: "Deacon",
        body: cardBody(),
        createdAt: "2026-09-08T10:00:00.000Z",
      },
    ]);
    await tick();
    root
      .querySelectorAll<HTMLButtonElement>('[data-testid="rich-decision-option"]')
      .forEach((b) => expect(b.disabled).toBe(false));
    expect(
      root.querySelector('[data-testid="rich-decision-answered"]'),
    ).toBeNull();
  });
});
