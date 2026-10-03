// @vitest-environment happy-dom

/**
 * The headless cloud-bot entry point.
 *
 * Creating a company-hosted bot exists on the server as the Team tab's
 * `add_agent` action plus the `create_agent` card. The server keeps one such
 * card per company channel and updates it in place, so the driver never reads
 * it: it asks where the card lives and answers it once with everything the
 * person chose.
 */
import { describe, expect, it, vi } from "vitest";

import {
  claudeSubscriptionSignInUrl,
  CLOUD_BOT_NAME_INVALID_REASON,
  CLOUD_BOT_NAME_TAKEN_REASON,
  CLOUD_BOT_NEEDS_MORE_REASON,
  CLOUD_BOT_NO_NEXT_STEP_REASON,
  CLOUD_BOT_SERVER_FAILED_REASON,
  runCreateCloudBotEntry,
  type CloudBotDraft,
  type CloudBotEntryApi,
} from "./lifecycle-entry-points.js";

const DRAFT: CloudBotDraft = {
  name: "Polar",
  handle: "ice-bear",
  runtime: "codex",
  size: "basic",
};
const CHANNEL = "chn_acme";
const AGENT_CHANNEL = "chn_polar";

/** What production answers for `team:spend/add_agent` on a paid company. */
const OPENED = {
  cardId: "team:spend",
  actionId: "add_agent",
  state: "open",
  navigateTo: "chat" as const,
  focusCardId: "create_agent",
  channelId: CHANNEL,
};

function harness(over: {
  opened?: Record<string, unknown> | Error;
  created?: Record<string, unknown> | Error;
} = {}) {
  const opened = over.opened ?? OPENED;
  const created = over.created ?? {
    cardId: "create_agent",
    actionId: "create",
    state: "done",
    agentChannelId: AGENT_CHANNEL,
    agentUid: "agt_polar",
  };
  const runCompanyTabAction = vi.fn(async (_args: Record<string, unknown>) => {
    if (opened instanceof Error) throw opened;
    return opened;
  });
  const runCardAction = vi.fn(async (_args: Record<string, unknown>) => {
    if (created instanceof Error) throw created;
    return created;
  });
  const logToFile = vi.fn(async (_tag: string, _message: string) => undefined);
  const api = {
    runCompanyTabAction,
    runCardAction,
    logToFile,
  } as unknown as CloudBotEntryApi;
  return { api, runCompanyTabAction, runCardAction, logToFile };
}

describe("runCreateCloudBotEntry", () => {
  it("opens the console authorization page only for Claude subscription auth", () => {
    expect(
      claudeSubscriptionSignInUrl(
        { runtime: "claude", authMode: "subscription" },
        "agt_123",
      ),
    ).toBe("https://hq.getindigo.ai/resolve/agents/agt_123");
    expect(
      claudeSubscriptionSignInUrl(
        { runtime: "claude", authMode: "apiKey" },
        "agt_123",
      ),
    ).toBeNull();
    expect(
      claudeSubscriptionSignInUrl(
        { runtime: "grok", authMode: "subscription" },
        "agt_123",
      ),
    ).toBeNull();
    expect(
      claudeSubscriptionSignInUrl(
        { runtime: "claude", authMode: "subscription" },
        "  ",
      ),
    ).toBeNull();
  });

  it("creates the bot with one complete action when the server answers the tab row id in cardId and the card in focusCardId", async () => {
    // Regression: production answers `cardId: "team:spend"` with the lifecycle
    // card in `focusCardId`. Reading only `cardId` ended every attempt with
    // "The server didn't send the next step" before anything was created.
    const { api, runCompanyTabAction, runCardAction, logToFile } = harness();
    const result = await runCreateCloudBotEntry(api, " cmp_acme ", DRAFT, {
      idempotencyKey: "idem-1",
    });
    expect(result).toEqual({
      ok: true,
      target: {
        channelId: AGENT_CHANNEL,
        cardId: null,
        cardKind: null,
        agentUid: "agt_polar",
      },
    });
    expect(runCompanyTabAction).toHaveBeenCalledTimes(1);
    expect(runCompanyTabAction).toHaveBeenCalledWith({
      companyUid: "cmp_acme",
      tab: "team",
      cardId: "team:spend",
      actionId: "add_agent",
      values: {},
      idempotencyKey: "idem-1",
    });
    expect(runCardAction).toHaveBeenCalledTimes(1);
    expect(runCardAction).toHaveBeenCalledWith({
      channelId: CHANNEL,
      cardId: "create_agent",
      actionId: "create",
      values: {
        name: "Polar",
        handle: "ice-bear",
        runtime: "codex",
        size: "basic",
        authMode: "subscription",
        deferChannels: "true",
        conversation: "dm",
        surface: "desktop_new_bot",
      },
    });
    expect(logToFile).not.toHaveBeenCalled();
  });

  it("never reads the channel: the stored card cannot decide what is created", async () => {
    const { api } = harness();
    const fetchChannel = vi.fn();
    (api as unknown as { fetchChannel: unknown }).fetchChannel = fetchChannel;
    await runCreateCloudBotEntry(api, "cmp_acme", DRAFT);
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it("carries the chosen runtime and write-only API-key auth on the create action only", async () => {
    const { api, runCardAction, runCompanyTabAction } = harness();
    await runCreateCloudBotEntry(api, "cmp_acme", {
      ...DRAFT,
      runtime: "claude",
      authMode: "apiKey",
      apiKey: "sk-test-not-a-real-key",
    });
    expect(runCardAction.mock.calls[0]![0]).toMatchObject({
      values: {
        runtime: "claude",
        authMode: "apiKey",
        apiKey: "sk-test-not-a-real-key",
      },
    });
    expect(JSON.stringify(runCompanyTabAction.mock.calls)).not.toContain("sk-test");
  });

  it("never sends the title: the card has no field for it", async () => {
    const { api, runCardAction } = harness();
    await runCreateCloudBotEntry(api, "cmp_acme", { ...DRAFT, title: "Analyst" });
    const sent = runCardAction.mock.calls[0]![0] as { values: Record<string, string> };
    expect(Object.keys(sent.values).sort()).toEqual(
      ["authMode", "conversation", "deferChannels", "handle", "name", "runtime", "size", "surface"].sort(),
    );
  });

  it("accepts a server that answers the lifecycle card directly in cardId", async () => {
    const { api, runCardAction } = harness({
      opened: { cardId: "create_agent", state: "open", channelId: CHANNEL },
    });
    const result = await runCreateCloudBotEntry(api, "cmp_acme", DRAFT);
    expect(result.ok).toBe(true);
    expect(runCardAction).toHaveBeenCalledTimes(1);
  });

  it("succeeds when the server made no channel for the bot: the conversation is the direct message", async () => {
    // Owner, 2026-10-02: a new bot must not come with a team channel.
    const h = harness({
      created: { cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_polar" },
    });
    const result = await runCreateCloudBotEntry(h.api, "cmp_acme", DRAFT);
    expect(result).toEqual({
      ok: true,
      target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_polar" },
    });
  });

  it("reports and logs when the server names no channel or card", async () => {
    const { api, runCardAction, logToFile } = harness({
      opened: { cardId: "team:spend", state: "open" },
    });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
      ok: false,
      reason: CLOUD_BOT_NO_NEXT_STEP_REASON,
      blocked: false,
    });
    expect(runCardAction).not.toHaveBeenCalled();
    expect(logToFile).toHaveBeenCalledWith(
      "cloud-bot",
      expect.stringContaining("exit=open-no-target"),
    );
  });

  it("reports the server's own refusal of add_agent without creating anything", async () => {
    const { api, runCardAction } = harness({
      opened: {
        cardId: "team:spend",
        state: "blocked",
        fields: [
          { id: "blocked_reason", value: "permission" },
          { id: "owner", value: "Corey" },
        ],
      },
    });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
      ok: false,
      reason: "You don't have permission to add bots here. Ask Corey.",
      blocked: true,
    });
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("lands on the upgrade card when the company's plan cannot host a bot", async () => {
    const { api, runCardAction } = harness({
      opened: { ...OPENED, focusCardId: "upgrade_plan" },
    });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
      ok: true,
      target: { channelId: CHANNEL, cardId: "upgrade_plan", cardKind: null },
    });
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("reports a plan refusal from the create action in plain words", async () => {
    const { api, logToFile } = harness({
      created: {
        cardId: "create_agent",
        state: "blocked",
        fields: [{ id: "blocked_reason", value: "plan" }],
      },
    });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
      ok: false,
      reason: "This company's plan doesn't include cloud bots yet.",
      blocked: true,
      upgrade: { channelId: CHANNEL, cardId: "upgrade_plan" },
    });
    expect(logToFile).toHaveBeenCalledWith(
      "cloud-bot",
      expect.stringContaining("exit=create-blocked why=plan"),
    );
  });

  it.each([
    ["This handle is already taken", CLOUD_BOT_NAME_TAKEN_REASON],
    ["Use lowercase letters, numbers and dashes", CLOUD_BOT_NAME_INVALID_REASON],
  ])(
    "speaks about the name, not the hidden handle, when the server says %j",
    async (error, reason) => {
      const { api } = harness({
        created: {
          cardId: "create_agent",
          state: "open",
          fields: [
            { id: "name", value: "Polar" },
            { id: "handle", value: "ice-bear", error },
          ],
        },
      });
      expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
        ok: false,
        reason,
        blocked: false,
      });
    },
  );

  it("says the server is not ready when it moves the card a turn instead of creating", async () => {
    const { api, logToFile } = harness({
      created: {
        cardId: "create_agent",
        state: "open",
        fields: [
          { id: "turn", value: "2" },
          { id: "name", value: "Someone else" },
        ],
      },
    });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
      ok: false,
      reason: CLOUD_BOT_NEEDS_MORE_REASON,
      blocked: false,
    });
    const line = String(logToFile.mock.calls[0]![1]);
    expect(line).toContain("exit=create-no-agent state=open turn=2");
    // Ids and states only: nothing a person typed reaches the log.
    expect(line).not.toContain("Someone else");
    expect(line).not.toContain("Polar");
  });

  it("offers no upgrade path for a permission refusal", async () => {
    const { api } = harness({
      created: {
        cardId: "create_agent",
        state: "blocked",
        fields: [
          { id: "blocked_reason", value: "permission" },
          { id: "owner", value: "Corey" },
        ],
      },
    });
    const result = await runCreateCloudBotEntry(api, "cmp_acme", DRAFT);
    expect(result).toEqual({
      ok: false,
      reason: "You don't have permission to add bots here. Ask Corey.",
      blocked: true,
    });
  });

  it("stops before any server call when the draft is missing a size or brain", async () => {
    const { api, runCardAction } = harness();
    expect(
      await runCreateCloudBotEntry(api, "cmp_acme", { name: "Polar", handle: "ice-bear" }),
    ).toEqual({ ok: false, reason: CLOUD_BOT_NEEDS_MORE_REASON, blocked: false });
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("reports a transport failure of the create action and flags permission errors", async () => {
    const plain = harness({ created: new Error("[run_card_action] network down") });
    expect(await runCreateCloudBotEntry(plain.api, "cmp_acme", DRAFT)).toEqual({
      ok: false,
      reason: "network down",
      blocked: false,
    });
    const denied = harness({ created: new Error("403 forbidden") });
    expect(await runCreateCloudBotEntry(denied.api, "cmp_acme", DRAFT)).toMatchObject({
      ok: false,
      blocked: true,
    });
  });

  it("never shows a raw backend error: a plain line on screen, the detail in the support log", async () => {
    // Regression (owner walkthrough 2026-10-02): a missing cloud permission
    // put the full "User: arn:aws:sts::... is not authorized to perform:
    // dynamodb:Scan on resource: arn:aws:dynamodb:..." text on the screen.
    const denial =
      "User: arn:aws:sts::000000000000:assumed-role/fn-role/fn is not authorized to perform: dynamodb:Scan on resource: arn:aws:dynamodb:us-east-1:000000000000:table/entities because no identity-based policy allows the dynamodb:Scan action";
    const { api, logToFile } = harness({ created: new Error(denial) });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toEqual({
      ok: false,
      reason: CLOUD_BOT_SERVER_FAILED_REASON,
      // The word "authorized" must not make this read as the person's refusal.
      blocked: false,
    });
    const line = String(logToFile.mock.calls[0]![1]);
    expect(line).toContain("exit=create-failed");
    expect(line).toContain("dynamodb:Scan");
    expect(line).not.toContain("Polar");
  });

  it.each([
    'agent create returned status 409: {"statusCode":409,"body":"{}"}',
    "AgentsFunction Unhandled: TypeError: x is not a function at handler (/var/task/bundle.js:1:1)",
    "x".repeat(200),
  ])("replaces backend text %j with the plain line", async (text) => {
    const { api } = harness({ created: new Error(text) });
    expect(await runCreateCloudBotEntry(api, "cmp_acme", DRAFT)).toMatchObject({
      ok: false,
      reason: CLOUD_BOT_SERVER_FAILED_REASON,
    });
  });

  it("asks for a company before doing anything", async () => {
    const { api, runCompanyTabAction } = harness();
    expect(await runCreateCloudBotEntry(api, "  ", DRAFT)).toEqual({
      ok: false,
      reason: "Pick a company first",
      blocked: false,
    });
    expect(runCompanyTabAction).not.toHaveBeenCalled();
  });
});
