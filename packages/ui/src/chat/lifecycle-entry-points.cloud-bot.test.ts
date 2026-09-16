// @vitest-environment happy-dom

/**
 * The headless cloud-bot entry point.
 *
 * Creating a company-hosted bot exists on the server only as the Team tab's
 * `add_agent` action plus the `create_agent` card's turns. That card is no
 * longer rendered anywhere, so this driver runs the same actions its buttons
 * ran and answers with the minted agent channel — no card, no focus.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_BOT_NEEDS_MORE_REASON,
  CLOUD_BOT_NO_NEXT_STEP_REASON,
  runCreateCloudBotEntry,
  type CloudBotEntryApi,
} from "./lifecycle-entry-points.js";

const DRAFT = { name: "Polar" };
const CHANNEL = "chn_acme";
const AGENT_CHANNEL = "chn_polar";

function card(
  cardId: string,
  fields: Array<Record<string, unknown>>,
  actionId: string,
  over: Record<string, unknown> = {},
) {
  return {
    v: 1,
    type: "lifecycle_card",
    cardId,
    kind: "create_agent",
    companyUid: "cmp_acme",
    state: "open",
    title: "Create an agent",
    fields,
    actions: [{ id: actionId, label: "Next", style: "primary" }],
    viewer: { canAct: true },
    ...over,
  };
}

function message(card: Record<string, unknown>) {
  return {
    eventId: `evt_${card.cardId}`,
    fromDisplayName: "HQ",
    body: "Create an agent",
    createdAt: "2026-09-15T12:00:00.000Z",
    direction: "in",
    messageKind: "system",
    systemEvent: card,
  };
}

const TURN_1 = card(
  "card_create_agent_1",
  [
    { id: "name", label: "Agent name", control: "text", required: true, value: "" },
    { id: "handle", label: "Handle", control: "text", required: true, value: "" },
  ],
  "next",
);
const TURN_2 = card(
  "card_create_agent_2",
  [
    {
      id: "runtime",
      label: "Runtime",
      control: "radio",
      required: true,
      value: "codex",
      options: [{ id: "codex", label: "Codex" }],
    },
  ],
  "next",
);
const TURN_3 = card(
  "card_create_agent_3",
  [
    {
      id: "size",
      label: "Size",
      control: "radio",
      required: true,
      value: "basic",
      options: [{ id: "basic", label: "Basic" }],
    },
  ],
  "create",
);

/** A server that posts each turn only once its predecessor is submitted. */
function server(turns = [TURN_1, TURN_2, TURN_3]) {
  let posted = turns.length ? [turns[0]!] : [];
  const runCardAction = vi.fn(async (args: { cardId: string; actionId: string; values: Record<string, string> }) => {
    const index = turns.findIndex((turn) => turn.cardId === args.cardId);
    if (index === turns.length - 1) {
      return {
        cardId: args.cardId,
        actionId: args.actionId,
        state: "done",
        agentChannelId: AGENT_CHANNEL,
        agentUid: "agt_polar",
      };
    }
    posted = [...posted, turns[index + 1]!];
    return { cardId: args.cardId, actionId: args.actionId, state: "done" };
  });
  const fetchChannel = vi.fn(async () => ({ messages: posted.map(message), nextCursor: null }));
  const runCompanyTabAction = vi.fn(async () => ({
    cardId: turns[0]?.cardId ?? "",
    actionId: "add_agent",
    state: "open",
    channelId: CHANNEL,
  }));
  return {
    api: { runCardAction, fetchChannel, runCompanyTabAction } as unknown as CloudBotEntryApi,
    runCardAction,
    fetchChannel,
    runCompanyTabAction,
  };
}

const fast = { sleep: async () => {}, pollMs: 0 };

describe("runCreateCloudBotEntry", () => {
  it("runs the whole server sequence and lands in the new bot's channel", async () => {
    const { api, runCardAction, runCompanyTabAction } = server();

    const result = await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast);

    expect(runCompanyTabAction).toHaveBeenCalledWith(
      expect.objectContaining({ companyUid: "cmp_acme", tab: "team", cardId: "team:spend", actionId: "add_agent" }),
    );
    // Turn 1 carries the name the New bot flow collected, and a handle made
    // from it — the two things the card's own form asked a person for.
    expect(runCardAction).toHaveBeenNthCalledWith(1, {
      channelId: CHANNEL,
      cardId: "card_create_agent_1",
      actionId: "next",
      values: { name: "Polar", handle: "polar" },
    });
    // Later turns keep whatever the server pre-filled.
    expect(runCardAction).toHaveBeenNthCalledWith(2, expect.objectContaining({ values: { runtime: "codex" } }));
    expect(runCardAction).toHaveBeenNthCalledWith(3, expect.objectContaining({ actionId: "create", values: { size: "basic" } }));
    // Nothing is focused: no card was ever drawn.
    expect(result).toEqual({
      ok: true,
      target: { channelId: AGENT_CHANNEL, cardId: null, cardKind: null },
    });
  });

  it("reports the server's own refusal without running a turn", async () => {
    const runCompanyTabAction = vi.fn(async () => ({
      cardId: "team:spend",
      actionId: "add_agent",
      state: "blocked",
      reason: "Only owners can add agents to Acme.",
    }));
    const runCardAction = vi.fn();
    const api = { runCompanyTabAction, runCardAction, fetchChannel: vi.fn() } as unknown as CloudBotEntryApi;

    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast)).toEqual({
      ok: false,
      reason: "Only owners can add agents to Acme.",
      blocked: true,
    });
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("lands on the upgrade card when the company's plan cannot host a bot", async () => {
    const upgrade = {
      ...card("card_upgrade_plan_1", [], "checkout"),
      kind: "upgrade_plan",
    };
    const runCompanyTabAction = vi.fn(async () => ({
      cardId: "card_upgrade_plan_1",
      actionId: "add_agent",
      state: "open",
      channelId: CHANNEL,
    }));
    const runCardAction = vi.fn();
    const api = {
      runCompanyTabAction,
      runCardAction,
      fetchChannel: async () => ({ messages: [message(upgrade)], nextCursor: null }),
    } as unknown as CloudBotEntryApi;

    // That card still renders, so it is a destination, not a failure — and
    // the driver must not start submitting turns on it.
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast)).toEqual({
      ok: true,
      target: { channelId: CHANNEL, cardId: "card_upgrade_plan_1", cardKind: null },
    });
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("stops with a plain reason when a turn asks for something it cannot fill in", async () => {
    const unknownTurn = card(
      "card_create_agent_1",
      [{ id: "budget", label: "Budget", control: "text", required: true, value: "" }],
      "next",
    );
    const { api, runCardAction } = server([unknownTurn]);

    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast)).toEqual({
      ok: false,
      reason: CLOUD_BOT_NEEDS_MORE_REASON,
      blocked: false,
    });
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("gives up instead of looping when the server never posts the next turn", async () => {
    const runCompanyTabAction = vi.fn(async () => ({
      cardId: "card_create_agent_1",
      actionId: "add_agent",
      state: "open",
      channelId: CHANNEL,
    }));
    const runCardAction = vi.fn(async () => ({
      cardId: "card_create_agent_1",
      actionId: "next",
      state: "done",
    }));
    const fetchChannel = vi.fn(async () => ({ messages: [message(TURN_1)], nextCursor: null }));
    const api = { runCompanyTabAction, runCardAction, fetchChannel } as unknown as CloudBotEntryApi;

    expect(
      await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, { ...fast, pollAttempts: 2 }),
    ).toEqual({ ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false });
    expect(runCardAction).toHaveBeenCalledOnce();
  });
});
