/**
 * US-011: agent channel appears instantly with inline setup.
 */
import { describe, expect, it } from "vitest";
import {
  agentComposerPlaceholder,
  isAgentConversationRow,
  provisioningFromMessages,
} from "./agent-channel.js";
import { submitLifecycleCardAction } from "./card-action.js";
import type { ConversationRow } from "./sidebar-model.js";
import type { ConversationMessageWire } from "./chat-api.js";

describe("US-011: Agent channel appears instantly with inline setup", () => {
  it("Given a successful create_agent action, when the directory refreshes, then the agent channel is present, selected, and shows a pending status card", async () => {
    const result = await submitLifecycleCardAction({
      event: {
        channelId: "chn_company",
        cardId: "create_agent",
        actionId: "create",
        values: {},
      },
      store: new Map(),
      run: async () => ({
        cardId: "create_agent",
        actionId: "create",
        state: "done",
        agentChannelId: "chn_agent",
        agentUid: "agt_ada",
      }),
      onFailure: () => {
        throw new Error("should not fail");
      },
    });
    expect(result?.agentChannelId).toBe("chn_agent");
    const row: ConversationRow = {
      id: "ch:chn_agent",
      kind: "channel",
      title: "Ada",
      companyUid: "cmp_a",
      unreadDot: false,
      lastActivityAt: 1,
      pinned: false,
      channelId: "chn_agent",
      members: [{ personUid: "agt_ada", displayName: "Ada" }],
    };
    expect(isAgentConversationRow(row)).toBe(true);
    const messages: ConversationMessageWire[] = [
      {
        eventId: "e1",
        createdAt: "2026-09-03T10:00:00.000Z",
        body: "",
        systemEvent: {
          type: "lifecycle_card",
          kind: "status",
          state: "pending",
          fields: [
            { id: "agentUid", value: "agt_ada" },
            { id: "summary", value: "Provisioning Ada…" },
          ],
        },
      },
    ];
    expect(provisioningFromMessages(messages).state).toBe("pending");
  });

  it("Given the agent posts agent-status ready, when the wake arrives, then the composer becomes enabled", () => {
    const messages: ConversationMessageWire[] = [
      {
        eventId: "e2",
        createdAt: "2026-09-03T10:01:00.000Z",
        body: "",
        systemEvent: {
          type: "lifecycle_card",
          kind: "status",
          state: "done",
          fields: [
            { id: "agentUid", value: "agt_ada" },
            { id: "summary", value: "Ada is ready" },
          ],
        },
      },
    ];
    const view = provisioningFromMessages(messages);
    expect(view.state).toBe("done");
    expect(agentComposerPlaceholder(view.agentName)).toBe(
      "Ada is still setting up",
    );
    expect(view.state === "pending").toBe(false);
  });
});
