import { describe, expect, it } from "vitest";
import {
  agentComposerPlaceholder,
  isAgentConversationRow,
  provisioningFromMessages,
} from "./agent-channel.js";
import type { ConversationRow } from "./sidebar-model.js";
import type { ConversationMessageWire } from "./chat-api.js";

function row(
  partial: Partial<ConversationRow> & Pick<ConversationRow, "id">,
): ConversationRow {
  return {
    kind: "channel",
    title: "Ada",
    companyUid: "cmp_a",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...partial,
  };
}

describe("isAgentConversationRow", () => {
  it("is true when a member uid is an agent", () => {
    expect(
      isAgentConversationRow(
        row({
          id: "ch:chn_a",
          members: [{ personUid: "agt_1", displayName: "Ada" }],
        }),
      ),
    ).toBe(true);
  });

  it("is false for ordinary company channels", () => {
    expect(
      isAgentConversationRow(
        row({
          id: "ch:chn_co",
          members: [{ personUid: "prs_o", displayName: "Corey" }],
        }),
      ),
    ).toBe(false);
  });
});

describe("provisioningFromMessages", () => {
  it("reads the latest status card", () => {
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
            { id: "agentUid", value: "agt_1" },
            { id: "summary", value: "Provisioning Ada…" },
          ],
        },
      },
    ];
    const view = provisioningFromMessages(messages);
    expect(view.state).toBe("pending");
    expect(view.agentName).toBe("Ada");
    expect(view.machineStartedAt).toBe("2026-09-03T10:00:00.000Z");
    expect(agentComposerPlaceholder(view.agentName)).toBe(
      "Ada is still setting up",
    );
  });

  it("flips to done when the status card is done", () => {
    const messages: ConversationMessageWire[] = [
      {
        eventId: "e1",
        createdAt: "2026-09-03T10:01:00.000Z",
        body: "",
        systemEvent: {
          type: "lifecycle_card",
          kind: "status",
          state: "done",
          fields: [
            { id: "agentUid", value: "agt_1" },
            { id: "summary", value: "Ada is ready" },
          ],
        },
      },
    ];
    const view = provisioningFromMessages(messages);
    expect(view.state).toBe("done");
    expect(view.checkedInAt).toBe("2026-09-03T10:01:00.000Z");
  });
});
