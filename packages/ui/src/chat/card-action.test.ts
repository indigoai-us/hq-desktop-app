import { describe, expect, it, vi } from "vitest";

import {
  beginCardActionIdempotencyKey,
  cardActionFailureMessage,
  CARD_ACTION_FAILED_MESSAGE,
  CARD_ACTION_FORBIDDEN_MESSAGE,
  endCardActionIdempotencyKey,
  patchLifecycleCardState,
  submitLifecycleCardAction,
  type CardActionIdempotencyStore,
} from "./card-action.js";
import type { ConversationMessageWire } from "./chat-api.js";
import type { LifecycleCardActionEvent } from "./messaging/channelMessageModels.js";

const event: LifecycleCardActionEvent = {
  channelId: "setup",
  cardId: "card_create_1",
  actionId: "submit",
  values: { name: "Ramen Bae" },
};

function cardMessage(
  state: string,
  reason?: string,
): ConversationMessageWire {
  return {
    eventId: "evt_lifecycle",
    createdAt: "2026-09-02T14:12:00.000Z",
    messageKind: "system",
    systemEvent: {
      v: 1,
      type: "lifecycle_card",
      cardId: "card_create_1",
      kind: "create_company",
      companyUid: null,
      state,
      reason,
      fields: [],
      actions: [{ id: "submit", label: "Create", style: "primary" }],
      viewer: { canAct: true },
    },
  };
}

describe("card action idempotency", () => {
  it("reuses one key while two submits are in flight", () => {
    const store: CardActionIdempotencyStore = new Map();
    let n = 0;
    const create = () => `key-${++n}`;
    const first = beginCardActionIdempotencyKey(store, event, create);
    const second = beginCardActionIdempotencyKey(store, event, create);
    expect(first).toBe("key-1");
    expect(second).toBe("key-1");
    endCardActionIdempotencyKey(store, event);
    endCardActionIdempotencyKey(store, event);
    const third = beginCardActionIdempotencyKey(store, event, create);
    expect(third).toBe("key-2");
  });
});

describe("cardActionFailureMessage", () => {
  it("maps a permission failure to plain copy instead of the server sentence", () => {
    expect(
      cardActionFailureMessage(
        new Error("[invoke] Viewer cannot act on this card"),
      ),
    ).toBe(CARD_ACTION_FORBIDDEN_MESSAGE);
  });

  it("never returns raw transport text; logs it and returns plain copy", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';
    const message = cardActionFailureMessage(new Error(raw));
    expect(message).toBe(CARD_ACTION_FAILED_MESSAGE);
    expect(message).not.toContain("boom");
    expect(message).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[card-action] action failed", raw);
    warn.mockRestore();
  });
});

describe("patchLifecycleCardState", () => {
  it("rewrites the matching card to blocked with a reason", () => {
    const next = patchLifecycleCardState([cardMessage("pending")], "card_create_1", {
      state: "blocked",
      reason: "Viewer cannot act on this card",
    });
    const envelope = next[0]?.systemEvent as Record<string, unknown>;
    expect(envelope.state).toBe("blocked");
    expect(envelope.reason).toBe("Viewer cannot act on this card");
    expect(envelope.statusLabel).toBe("Blocked");
    expect(next[0]?.eventId).toBe("evt_lifecycle");
  });
});

describe("submitLifecycleCardAction", () => {
  it("sends the same idempotencyKey when submitted twice quickly", async () => {
    const store: CardActionIdempotencyStore = new Map();
    const keys: string[] = [];
    const run = async (args: { idempotencyKey?: string }) => {
      keys.push(args.idempotencyKey ?? "");
      return {
        cardId: event.cardId,
        actionId: event.actionId,
        state: "pending",
      };
    };
    await Promise.all([
      submitLifecycleCardAction({
        event,
        store,
        run,
        onFailure: () => {
          throw new Error("should not fail");
        },
      }),
      submitLifecycleCardAction({
        event,
        store,
        run,
        onFailure: () => {
          throw new Error("should not fail");
        },
      }),
    ]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("returns the create_agent agentChannelId so the shell can select it", async () => {
    const store: CardActionIdempotencyStore = new Map();
    const result = await submitLifecycleCardAction({
      event,
      store,
      run: async () => ({
        cardId: event.cardId,
        actionId: event.actionId,
        state: "done",
        agentChannelId: "chn_agent",
        agentUid: "agt_1",
      }),
      onFailure: () => {
        throw new Error("should not fail");
      },
    });
    expect(result).toMatchObject({ agentChannelId: "chn_agent" });
  });

  it("surfaces a 403 on the card via onFailure, never as a thrown toast", async () => {
    const store: CardActionIdempotencyStore = new Map();
    const failures: Array<{ cardId: string; message: string }> = [];
    await submitLifecycleCardAction({
      event,
      store,
      run: async () => {
        throw new Error("[invoke] Viewer cannot act on this card");
      },
      onFailure: (cardId, message) => failures.push({ cardId, message }),
    });
    expect(failures).toEqual([
      { cardId: "card_create_1", message: CARD_ACTION_FORBIDDEN_MESSAGE },
    ]);
  });
});
