// @vitest-environment happy-dom

/**
 * US-008 story acceptance: lifecycle cards render in the desktop chat UI.
 *
 * Zero-network: ChannelConversation bubbles oncardaction. Unknown versions
 * render nothing. Design lock: #setup is not grouped by threadKey.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./messaging/ChannelConversation.svelte";
import type { LifecycleCardActionEvent } from "./messaging/channelMessageModels.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountConversation(
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
          eventId: "evt_lifecycle",
          direction: "in",
          fromDisplayName: "HQ",
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

describe("US-008: Lifecycle card renderer in the desktop chat UI", () => {
  it("Given a lifecycle_card with a text field and a primary action, when the user fills it and submits, then oncardaction fires with the values and the card shows pending until the next message refresh", async () => {
    const oncardaction = vi.fn();
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
          value: "",
        },
      ],
      actions: [{ id: "submit", label: "Create", style: "primary" }],
      viewer: { canAct: true },
    };
    const root = mountConversation(envelope, { oncardaction });
    await tick();

    const input = root.querySelector("input.lc-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "Ramen Bae";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    root
      .querySelector<HTMLButtonElement>('[data-testid="lifecycle-action-submit"]')
      ?.click();
    flushSync();
    await Promise.resolve();

    expect(oncardaction).toHaveBeenCalledTimes(1);
    const event = oncardaction.mock.calls[0][0] as LifecycleCardActionEvent;
    expect(event).toEqual({
      channelId: "setup",
      cardId: "card_create_1",
      actionId: "submit",
      values: { name: "Ramen Bae" },
    });
    expect(
      root.querySelector("[data-testid='lifecycle-card']")?.getAttribute("data-state"),
    ).toBe("pending");
    expect(root.querySelector(".lc-spin")).not.toBeNull();

    if (component) await unmount(component);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        channelId: "setup",
        messages: [
          {
            eventId: "evt_lifecycle",
            direction: "in",
            fromDisplayName: "HQ",
            body: "",
            createdAt: "2026-09-02T14:12:00.000Z",
            messageKind: "system",
            systemEvent: { ...envelope, state: "done", statusLabel: "Done" },
          },
        ],
      },
    });
    await tick();
    expect(
      root.querySelector("[data-testid='lifecycle-card']")?.getAttribute("data-state"),
    ).toBe("done");
    expect(root.querySelector(".lc-spin")).toBeNull();
  });

  it("Given a blocked card, when rendered, then controls are disabled and the block reason is visible", async () => {
    const oncardaction = vi.fn();
    const root = mountConversation(
      {
        v: 1,
        type: "lifecycle_card",
        cardId: "card_agent_1",
        kind: "create_agent",
        companyUid: "cmp_acme",
        state: "blocked",
        title: "Create an agent",
        reason: "Agents come with Workforce. Upgrade in step 3 and this unlocks.",
        statusLabel: "Needs Workforce",
        fields: [
          {
            id: "name",
            label: "Agent name",
            control: "text",
            required: true,
            value: "Polar",
          },
        ],
        actions: [{ id: "submit", label: "Create Polar", style: "primary" }],
        viewer: { canAct: true },
      },
      { oncardaction },
    );
    await tick();

    expect(
      root.querySelector("[data-testid='lifecycle-card-reason']")?.textContent,
    ).toContain("Agents come with Workforce");
    const submit = root.querySelector(
      '[data-testid="lifecycle-action-submit"]',
    ) as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(true);
    expect(root.querySelector("input.lc-input")).toBeNull();
    submit?.click();
    await tick();
    expect(oncardaction).not.toHaveBeenCalled();
  });
});
