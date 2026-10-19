/**
 * The shell's ConversationApi: the platform adapter's messaging calls, with
 * adapter results unwrapped (failures thrown) and payloads normalized for the
 * chat components.
 */
import type { PlatformAdapter } from "@hq/platform";
import type { ConversationApi, ReplyThreadResponse } from "../../chat/chat-api.js";
import {
  normalizeConversationMessages,
  timelinePageFromPayload,
} from "../../chat/live-messages.js";

/** Unwrap an adapter result, throwing its message (with code) on failure. */
export function unwrapAdapter<T>(
  result:
    | { ok: true; value: T }
    | { ok?: false; message?: string; reason?: string; code?: string },
): T {
  if ("ok" in result && result.ok) return result.value;
  const fail = result as { message?: string; reason?: string; code?: string };
  const detail = fail.message ?? fail.reason ?? "request failed";
  throw new Error(fail.code ? `[${fail.code}] ${detail}` : detail);
}

/** Normalize a raw reply-thread payload into the chat reply-thread shape. */
export function asReplyThread(value: unknown): ReplyThreadResponse {
  const rec =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rootRows = rec.root ? normalizeConversationMessages([rec.root]) : [];
  const replies = normalizeConversationMessages(rec.replies ?? []);
  const root = rootRows[0] ?? null;
  const rootCount = root?.replyCount;
  const replyCount =
    typeof rec.replyCount === "number"
      ? rec.replyCount
      : (rootCount ?? replies.length);
  return {
    scope: rec.scope === "dm" ? "dm" : "channel",
    root,
    replies,
    replyCount,
  };
}

/**
 * Build the ConversationApi over a platform adapter. Only closes over the
 * adapter, which is fixed for the life of the shell.
 */
export function createConversationApi(adapter: PlatformAdapter): ConversationApi {
  return {
    fetchChannel: async (args) => {
      const raw = unwrapAdapter(await adapter.messaging.fetchChannel(args));
      const page = timelinePageFromPayload(raw);
      return {
        messages: normalizeConversationMessages(page.messages, { keepAudience: true }),
        nextCursor: page.nextCursor ?? null,
        ...(page.view ? { view: page.view } : {}),
        ...(page.viewScanTruncated ? { viewScanTruncated: true } : {}),
      };
    },
    sendChannelMessage: async (args) => {
      unwrapAdapter(
        await adapter.messaging.sendChannelMessage(args.channelId, args.body, {
          mentions: args.mentions,
          attachments: args.attachments,
        }),
      );
    },
    fetchDmThread: async (args) => {
      const raw = unwrapAdapter(await adapter.messaging.fetchDmThread(args));
      const page = timelinePageFromPayload(raw);
      return {
        messages: normalizeConversationMessages(page.messages, { keepAudience: true }),
        nextCursor: page.nextCursor ?? null,
        ...(page.view ? { view: page.view } : {}),
        ...(page.viewScanTruncated ? { viewScanTruncated: true } : {}),
      };
    },
    sendDm: async (args) => {
      unwrapAdapter(
        await adapter.messaging.sendDm(args.toPersonUid, args.body, {
          attachments: args.attachments,
        }),
      );
    },
    fetchReplyThread: async (args) =>
      asReplyThread(
        unwrapAdapter(await adapter.messaging.fetchReplyThread(args)),
      ),
    sendReply: async (args) => {
      unwrapAdapter(await adapter.messaging.sendReply(args));
    },
    listChannelAgentTasks: adapter.messaging.listChannelAgentTasks
      ? async (args) =>
          unwrapAdapter(
            await adapter.messaging.listChannelAgentTasks!(args.agentUid, args.channelId),
          )
      : undefined,
    listAgentTasks: adapter.messaging.listAgentTasks
      ? async (args) => unwrapAdapter(await adapter.messaging.listAgentTasks!(args.agentUid))
      : undefined,
    runCardAction: async (args) => {
      const raw = unwrapAdapter(
        await adapter.messaging.runCardAction(args),
      ) as Record<string, unknown> | undefined;
      return {
        cardId: typeof raw?.cardId === "string" ? raw.cardId : args.cardId,
        actionId: typeof raw?.actionId === "string" ? raw.actionId : args.actionId,
        eventId: typeof raw?.eventId === "string" ? raw.eventId : undefined,
        state: typeof raw?.state === "string" ? raw.state : "",
        fields: raw?.fields,
        replayed: raw?.replayed === true,
        // US-006/011: create_agent accept mints the agent channel; keep the
        // ids so handleCardAction can select it (they were dropped here).
        agentChannelId:
          typeof raw?.agentChannelId === "string" ? raw.agentChannelId : undefined,
        agentUid: typeof raw?.agentUid === "string" ? raw.agentUid : undefined,
        companyChannelId: typeof raw?.companyChannelId === "string" ? raw.companyChannelId : undefined,
        companyUid: typeof raw?.companyUid === "string" ? raw.companyUid : undefined,
        focusCardId:
          typeof raw?.focusCardId === "string" ? raw.focusCardId : undefined,
        // Entry points: the summary card's create_company action answers with
        // the channel + card it posted; pending checkout answers with a url.
        channelId:
          typeof raw?.channelId === "string" ? raw.channelId : undefined,
        reason: typeof raw?.reason === "string" ? raw.reason : undefined,
        url: typeof raw?.url === "string" ? raw.url : undefined,
      };
    },
    checkCompanySlug: adapter.messaging.checkCompanySlug
      ? async (slug: string) =>
          unwrapAdapter(await adapter.messaging.checkCompanySlug!(slug))
      : undefined,
    activateCompanyCloud: adapter.messaging.activateCompanyCloud
      ? async (companyUid: string) =>
          unwrapAdapter(await adapter.messaging.activateCompanyCloud!(companyUid))
      : undefined,
    getCompanyTab: adapter.messaging.getCompanyTab
      ? async (companyUid, tabId) =>
          unwrapAdapter(await adapter.messaging.getCompanyTab!(companyUid, tabId))
      : undefined,
    runCompanyTabAction: adapter.messaging.runCompanyTabAction
      ? async (args) => {
          const raw = unwrapAdapter(
            await adapter.messaging.runCompanyTabAction!(args),
          ) as Record<string, unknown> | undefined;
          return {
            cardId: typeof raw?.cardId === "string" ? raw.cardId : args.cardId,
            actionId:
              typeof raw?.actionId === "string" ? raw.actionId : args.actionId,
            eventId: typeof raw?.eventId === "string" ? raw.eventId : undefined,
            state: typeof raw?.state === "string" ? raw.state : "",
            fields: raw?.fields,
            replayed: raw?.replayed === true,
            agentChannelId:
              typeof raw?.agentChannelId === "string" ? raw.agentChannelId : undefined,
            agentUid: typeof raw?.agentUid === "string" ? raw.agentUid : undefined,
            navigateTo:
              raw?.navigateTo === "chat" ? "chat" : undefined,
            focusCardId:
              typeof raw?.focusCardId === "string" ? raw.focusCardId : undefined,
            channelId:
              typeof raw?.channelId === "string" ? raw.channelId : undefined,
            reason: typeof raw?.reason === "string" ? raw.reason : undefined,
            url: typeof raw?.url === "string" ? raw.url : undefined,
          };
        }
      : undefined,
  };
}
