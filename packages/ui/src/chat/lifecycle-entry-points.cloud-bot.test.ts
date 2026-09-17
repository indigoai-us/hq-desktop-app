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
  cloudBotStaleCardReason,
  runCreateCloudBotEntry,
  type CloudBotEntryApi,
} from "./lifecycle-entry-points.js";

/** What the New bot flow collected: the name typed, and the handle shown beside it. */
const DRAFT = { name: "Polar", handle: "ice-bear" };
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

/**
 * One wire row. `age` is how many minutes back it sits, so a page written
 * newest-first carries descending timestamps, the way a real one does.
 */
function message(card: Record<string, unknown>, age = 0) {
  const at = new Date(Date.parse("2026-09-15T12:00:00.000Z") - age * 60_000).toISOString();
  return {
    eventId: `evt_${card.cardId}`,
    fromDisplayName: "HQ",
    body: "Create an agent",
    createdAt: at,
    direction: "in",
    messageKind: "system",
    systemEvent: card,
  };
}

/**
 * A `fetch_channel` page, in the order the wire really delivers one: NEWEST
 * first (crates/hq-desktop-core/src/messages.rs, `ChannelDetail`). Fixtures
 * hand this the cards in the order the turns happened, so what the driver
 * reads is always the reverse of what the server posted — exactly like
 * production.
 */
function wirePage(oldestFirst: ReadonlyArray<Record<string, unknown>>) {
  const newestFirst = [...oldestFirst].reverse();
  return { messages: newestFirst.map((row, i) => message(row, i)), nextCursor: null };
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
  const fetchChannel = vi.fn(async () => wirePage(posted));
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
    // Turn 1 carries the name AND the handle the person chose in the New bot
    // flow — the two things the card's own form used to ask them for. The
    // handle is theirs, not a slug of the name they happened to type.
    expect(runCardAction).toHaveBeenNthCalledWith(1, {
      channelId: CHANNEL,
      cardId: "card_create_agent_1",
      actionId: "next",
      values: { name: "Polar", handle: "ice-bear" },
    });
    // Later turns keep whatever the server pre-filled.
    expect(runCardAction).toHaveBeenNthCalledWith(2, expect.objectContaining({ values: { runtime: "codex" } }));
    expect(runCardAction).toHaveBeenNthCalledWith(3, expect.objectContaining({ actionId: "create", values: { size: "basic" } }));
    // Nothing is focused: no card was ever drawn. The new bot's uid rides
    // back with the target: no turn asked for the draft's title, so the
    // caller writes it onto that agent's profile.
    expect(result).toEqual({
      ok: true,
      target: { channelId: AGENT_CHANNEL, cardId: null, cardKind: null, agentUid: "agt_polar" },
    });
  });

  it("never sends the title to a card — no turn of the sequence has a field for it", async () => {
    const { api, runCardAction } = server();

    const result = await runCreateCloudBotEntry(
      api,
      "cmp_acme",
      { ...DRAFT, title: "Ad account analyst" },
      fast,
    );

    for (const call of runCardAction.mock.calls) {
      expect(call[0]!.values).not.toHaveProperty("title");
    }
    expect(runCardAction).toHaveBeenNthCalledWith(1, {
      channelId: CHANNEL,
      cardId: "card_create_agent_1",
      actionId: "next",
      values: { name: "Polar", handle: "ice-bear" },
    });
    // The uid the caller needs to save that title instead.
    expect(result).toEqual({
      ok: true,
      target: { channelId: AGENT_CHANNEL, cardId: null, cardKind: null, agentUid: "agt_polar" },
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
      fetchChannel: async () => wirePage([upgrade]),
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
    const fetchChannel = vi.fn(async () => wirePage([TURN_1]));
    const api = { runCompanyTabAction, runCardAction, fetchChannel } as unknown as CloudBotEntryApi;

    expect(
      await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, { ...fast, pollAttempts: 2 }),
    ).toEqual({ ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false });
    expect(runCardAction).toHaveBeenCalledOnce();
  });
});

/**
 * A server that behaves like the real one where it matters: `add_agent`
 * RESURFACES any live create_agent card instead of posting a second one, turn
 * 1 refuses a handle that is already taken, and each turn posts the next only
 * once its predecessor is answered. The refusal is the shape the dev harness
 * (and the server) uses: the card goes `blocked`, keeps its reason, and offers
 * its own "Try another handle".
 */
function liveServer(options: { taken?: readonly string[]; dismissable?: boolean } = {}) {
  const taken = new Set(options.taken ?? []);
  const cards: Array<Record<string, unknown>> = [];
  const extra = options.dismissable ? [{ id: "dismiss", label: "Never mind", style: "secondary" }] : [];
  let created: { name: string; handle: string } | null = null;
  let seq = 0;

  const isLive = (row: Record<string, unknown>) =>
    row.state === "open" || row.state === "pending" || row.state === "blocked";
  const at = (cardId: string) => cards.find((row) => row.cardId === cardId);

  function turn(n: 1 | 2 | 3, suffix: string): Record<string, unknown> {
    const fields =
      n === 1
        ? [
            { id: "name", label: "Agent name", control: "text", required: true, value: "polar" },
            { id: "handle", label: "Handle", control: "text", required: true, value: "polar" },
          ]
        : n === 2
          ? [{ id: "runtime", label: "Runtime", control: "radio", required: true, value: "codex", options: [{ id: "codex", label: "Codex" }] }]
          : [{ id: "size", label: "Size", control: "radio", required: true, value: "basic", options: [{ id: "basic", label: "Basic" }] }];
    return {
      v: 1,
      type: "lifecycle_card",
      cardId: `card_create_agent_${n}${suffix}`,
      kind: "create_agent",
      companyUid: "cmp_acme",
      state: "open",
      title: "Create an agent",
      fields,
      actions: [{ id: n === 3 ? "create" : "next", label: "Next", style: "primary" }, ...extra],
      viewer: { canAct: true },
    };
  }

  const runCompanyTabAction = vi.fn(async () => {
    const existing = [...cards].reverse().find((row) => row.kind === "create_agent" && isLive(row));
    if (existing) {
      return { cardId: existing.cardId as string, actionId: "add_agent", state: "open", channelId: CHANNEL };
    }
    seq += 1;
    const posted = turn(1, cards.length ? `_${seq}` : "");
    cards.push(posted);
    return { cardId: posted.cardId as string, actionId: "add_agent", state: "open", channelId: CHANNEL };
  });

  const runCardAction = vi.fn(
    async (args: { cardId: string; actionId: string; values: Record<string, string> }) => {
      const row = at(args.cardId);
      if (!row) throw new Error("Request failed (status 404)");
      if (args.actionId === "dismiss") {
        row.state = "skipped";
        return { cardId: args.cardId, actionId: args.actionId, state: "skipped" };
      }
      const suffix = args.cardId.replace(/^card_create_agent_[123]/, "");
      if (args.cardId.startsWith("card_create_agent_1")) {
        const handle = (args.values.handle ?? "").trim();
        if (taken.has(handle)) {
          row.state = "blocked";
          row.statusLabel = "Blocked";
          row.reason = `@${handle} is already taken in Acme.`;
          row.actions = [{ id: "retry", label: "Try another handle", style: "primary" }, ...extra];
          return { cardId: args.cardId, actionId: args.actionId, state: "blocked" };
        }
        created = { name: args.values.name ?? "", handle };
        row.state = "done";
        row.statusLabel = `@${handle}`;
        row.actions = [];
        cards.push(turn(2, suffix));
        return { cardId: args.cardId, actionId: args.actionId, state: "done" };
      }
      if (args.cardId.startsWith("card_create_agent_2")) {
        row.state = "done";
        row.actions = [];
        cards.push(turn(3, suffix));
        return { cardId: args.cardId, actionId: args.actionId, state: "done" };
      }
      row.state = "done";
      row.actions = [];
      return {
        cardId: args.cardId,
        actionId: args.actionId,
        state: "done",
        agentChannelId: AGENT_CHANNEL,
        agentUid: "agt_polar",
      };
    },
  );

  const fetchChannel = vi.fn(async () => wirePage(cards));

  return {
    api: { runCardAction, fetchChannel, runCompanyTabAction } as unknown as CloudBotEntryApi,
    runCardAction,
    runCompanyTabAction,
    cards,
    stateOf: (cardId: string) => at(cardId)?.state ?? null,
    get created() {
      return created;
    },
  };
}

describe("runCreateCloudBotEntry — the card nobody can see", () => {
  it("answers a refusal left from an earlier attempt instead of returning it forever", async () => {
    const server = liveServer({ taken: ["acme"] });

    const refused = await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Acme", handle: "acme" },
      fast,
    );
    expect(refused).toEqual({
      ok: false,
      reason: "@acme is already taken in Acme.",
      blocked: true,
    });
    // The refused card stays live and invisible, so `add_agent` hands it back
    // to the next attempt. That attempt is a NEW attempt: the driver runs the
    // card's own "try again" with the values this person just chose.
    expect(server.stateOf("card_create_agent_1")).toBe("blocked");

    const retried = await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Polar", handle: "polar" },
      fast,
    );
    expect(retried).toEqual({
      ok: true,
      target: { channelId: AGENT_CHANNEL, cardId: null, cardKind: null, agentUid: "agt_polar" },
    });
    expect(server.created).toEqual({ name: "Polar", handle: "polar" });
    expect(server.runCardAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "retry", values: { name: "Polar", handle: "polar" } }),
    );
  });

  it("puts a refused card away when the server offers a way to", async () => {
    const server = liveServer({ taken: ["acme"], dismissable: true });

    await runCreateCloudBotEntry(server.api, "cmp_acme", { name: "Acme", handle: "acme" }, fast);
    // Nobody can see this card, so nobody else can clear it.
    expect(server.stateOf("card_create_agent_1")).toBe("skipped");

    const retried = await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Polar", handle: "polar" },
      fast,
    );
    expect(retried.ok).toBe(true);
    expect(server.created).toEqual({ name: "Polar", handle: "polar" });
    // A fresh sequence, not the dismissed one: a second opening card was
    // posted and answered.
    const openings = server.cards.filter((row) => String(row.cardId).startsWith("card_create_agent_1"));
    expect(openings.map((row) => row.state)).toEqual(["skipped", "done"]);
  });

  it("never finishes a sequence that was opened for a different bot", async () => {
    const server = liveServer();
    // An attempt that dies after turn 1 leaves a live turn-2 card. Its
    // recorded name is @polar's, and turn 2 has no name field to correct.
    const died = await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Polar", handle: "polar" },
      { ...fast, maxTurns: 1 },
    );
    expect(died).toEqual({ ok: false, reason: CLOUD_BOT_NO_NEXT_STEP_REASON, blocked: false });
    expect(server.stateOf("card_create_agent_2")).toBe("open");

    const other = await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Scout", handle: "scout" },
      fast,
    );
    expect(other).toEqual({ ok: false, reason: cloudBotStaleCardReason("polar"), blocked: false });
    // Nothing was submitted into it: no bot exists under the wrong name.
    expect(server.runCardAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "card_create_agent_2" }),
    );
  });

  it("resumes a sequence it opened under this very handle", async () => {
    const server = liveServer();
    await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Polar", handle: "polar" },
      { ...fast, maxTurns: 1 },
    );

    // The same person, the same bot: finishing what they started is exactly
    // what they asked for.
    const finished = await runCreateCloudBotEntry(
      server.api,
      "cmp_acme",
      { name: "Polar", handle: "polar" },
      fast,
    );
    expect(finished).toEqual({
      ok: true,
      target: { channelId: AGENT_CHANNEL, cardId: null, cardKind: null, agentUid: "agt_polar" },
    });
    expect(server.created).toEqual({ name: "Polar", handle: "polar" });
  });

  it("waits for an opening card the server posts asynchronously", async () => {
    let posted = false;
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
      agentChannelId: AGENT_CHANNEL,
    }));
    // The first read-back is empty: the card lands a beat later, the same way
    // every later turn does.
    const fetchChannel = vi.fn(async () => {
      const page = wirePage(posted ? [TURN_1] : []);
      posted = true;
      return page;
    });
    const api = { runCompanyTabAction, runCardAction, fetchChannel } as unknown as CloudBotEntryApi;

    // No uid in the answer, so none is passed on: the caller has nothing to
    // write a profile onto, rather than a uid it made up.
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast)).toEqual({
      ok: true,
      target: { channelId: AGENT_CHANNEL, cardId: null, cardKind: null },
    });
    expect(runCardAction).toHaveBeenCalledOnce();
  });

  it("follows the newest matching card, not an older one still open", async () => {
    const stale = card(
      "card_create_agent_dead",
      [
        { id: "runtime", label: "Runtime", control: "radio", required: true, value: "claude", options: [{ id: "claude", label: "Claude" }] },
      ],
      "next",
    );
    // Written the way the wire really answers — NEWEST first — and by hand,
    // not through `wirePage`, so this test states the order itself: the
    // leftover open card is the OLDEST row, behind the turn just posted.
    let wire: Array<Record<string, unknown>> = [TURN_1, stale];
    const runCompanyTabAction = vi.fn(async () => ({
      cardId: "card_create_agent_1",
      actionId: "add_agent",
      state: "open",
      channelId: CHANNEL,
    }));
    const runCardAction = vi.fn(async (args: { cardId: string }) => {
      if (args.cardId === "card_create_agent_1") {
        wire = [TURN_3, { ...TURN_1, state: "done" }, stale];
        return { cardId: args.cardId, actionId: "next", state: "done" };
      }
      return {
        cardId: args.cardId,
        actionId: "create",
        state: "done",
        agentChannelId: AGENT_CHANNEL,
      };
    });
    const fetchChannel = vi.fn(async () => ({
      messages: wire.map((row, i) => message(row, i)),
      nextCursor: null,
    }));
    const api = { runCompanyTabAction, runCardAction, fetchChannel } as unknown as CloudBotEntryApi;

    expect((await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast)).ok).toBe(true);
    expect(runCardAction).toHaveBeenNthCalledWith(2, expect.objectContaining({ cardId: "card_create_agent_3" }));
  });

  it("reads a newest-first page: the newer open card wins and the stale guard sees it", async () => {
    // One page, two live cards: an opening turn finished for @polar, and the
    // turn-2 card it left behind. On the wire the turn-2 card is the NEWEST
    // row and the opening turn sits behind it — the shape that made a driver
    // reading the page backwards submit @polar's sequence for someone else.
    const openedForPolar = card(
      "card_create_agent_1",
      [
        { id: "name", label: "Agent name", control: "text", required: true, value: "polar" },
        { id: "handle", label: "Handle", control: "text", required: true, value: "polar" },
      ],
      "next",
      { state: "done", statusLabel: "@polar", actions: [] },
    );
    const leftBehind = card(
      "card_create_agent_2",
      [
        { id: "runtime", label: "Runtime", control: "radio", required: true, value: "codex", options: [{ id: "codex", label: "Codex" }] },
      ],
      "next",
    );
    const runCompanyTabAction = vi.fn(async () => ({
      // `add_agent` resurfaces the live card, exactly as the server does.
      cardId: "card_create_agent_2",
      actionId: "add_agent",
      state: "open",
      channelId: CHANNEL,
    }));
    const runCardAction = vi.fn(async (args: { cardId: string }) => ({
      cardId: args.cardId,
      actionId: "next",
      state: "done",
    }));
    const fetchChannel = vi.fn(async () => ({
      // NEWEST first: [turn 2, the opening turn behind it].
      messages: [message(leftBehind, 0), message(openedForPolar, 1)],
      nextCursor: null,
    }));
    const api = { runCompanyTabAction, runCardAction, fetchChannel } as unknown as CloudBotEntryApi;

    // Someone else's draft: the guard must find the opening turn that is
    // OLDER than the card it was handed, read @polar off it, and refuse.
    expect(
      await runCreateCloudBotEntry(api, "cmp_acme", { name: "Scout", handle: "scout" }, fast),
    ).toEqual({ ok: false, reason: cloudBotStaleCardReason("polar"), blocked: false });
    // Nothing was submitted: no bot made under the previous draft's handle.
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("keeps the server's own refusal when its 'try again' asks for something it cannot fill", async () => {
    // The refusal re-renders with a field this draft has no value for, so
    // the recovery cannot be run. That does not turn a refusal into a miss.
    const refused = card(
      "card_create_agent_1",
      [
        { id: "name", label: "Agent name", control: "text", required: true, value: "acme" },
        { id: "handle", label: "Handle", control: "text", required: true, value: "acme" },
        { id: "budget", label: "Monthly budget", control: "text", required: true, value: "" },
      ],
      "retry",
      { state: "blocked", statusLabel: "Blocked", reason: "@acme is already taken in Acme." },
    );
    const runCompanyTabAction = vi.fn(async () => ({
      cardId: "card_create_agent_1",
      actionId: "add_agent",
      state: "open",
      channelId: CHANNEL,
    }));
    const runCardAction = vi.fn();
    const fetchChannel = vi.fn(async () => wirePage([refused]));
    const api = { runCompanyTabAction, runCardAction, fetchChannel } as unknown as CloudBotEntryApi;

    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT, fast)).toEqual({
      ok: false,
      // The server's words, in plain language, and still flagged a refusal.
      reason: "@acme is already taken in Acme.",
      blocked: true,
    });
    expect(runCardAction).not.toHaveBeenCalled();
  });
});
