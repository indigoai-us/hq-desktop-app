/**
 * Desktop ConversationApi factory (US-009).
 *
 * packages/ui DesktopApp also builds this seam from PlatformAdapter. This
 * module is the Sync-side adapter tests (and any host that wants the same
 * unwrap) use: `runCardAction` maps to the `run_card_action` Tauri command.
 */

import type { AdapterResult, PlatformAdapter } from '@hq/platform';
import type {
  CardActionResult,
  ChannelDetailResponse,
  ConversationApi,
  DmThreadResponse,
  ReplyThreadResponse,
} from '@hq/ui';

function unwrap<T>(result: AdapterResult<T>): T {
  if (result.ok) return result.value;
  const detail = result.message ?? result.reason ?? 'request failed';
  throw new Error(result.code ? `[${result.code}] ${detail}` : detail);
}

function asReplyThread(value: unknown): ReplyThreadResponse {
  const rec =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const root =
    rec.root && typeof rec.root === 'object' && !Array.isArray(rec.root)
      ? (rec.root as ReplyThreadResponse['root'])
      : null;
  const replies = Array.isArray(rec.replies)
    ? (rec.replies as ReplyThreadResponse['replies'])
    : [];
  const rootCount =
    root && typeof root.replyCount === 'number' ? root.replyCount : undefined;
  const replyCount =
    typeof rec.replyCount === 'number'
      ? rec.replyCount
      : (rootCount ?? replies.length);
  return {
    scope: rec.scope === 'dm' ? 'dm' : 'channel',
    root,
    replies,
    replyCount,
  };
}

function asCardAction(
  value: unknown,
  args: { cardId: string; actionId: string },
): CardActionResult {
  const rec =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    cardId: typeof rec.cardId === 'string' ? rec.cardId : args.cardId,
    actionId: typeof rec.actionId === 'string' ? rec.actionId : args.actionId,
    eventId: typeof rec.eventId === 'string' ? rec.eventId : undefined,
    state: typeof rec.state === 'string' ? rec.state : '',
    fields: rec.fields,
    replayed: rec.replayed === true,
  };
}

export function createConversationApi(
  adapter: PlatformAdapter,
): ConversationApi {
  return {
    fetchChannel: async (args) =>
      unwrap(
        await adapter.messaging.fetchChannel(args),
      ) as unknown as ChannelDetailResponse,
    sendChannelMessage: async (args) => {
      unwrap(
        await adapter.messaging.sendChannelMessage(args.channelId, args.body, {
          mentions: args.mentions,
          attachments: args.attachments,
        }),
      );
    },
    fetchDmThread: async (args) =>
      unwrap(
        await adapter.messaging.fetchDmThread(args),
      ) as unknown as DmThreadResponse,
    sendDm: async (args) => {
      unwrap(
        await adapter.messaging.sendDm(args.toPersonUid, args.body, {
          attachments: args.attachments,
        }),
      );
    },
    fetchReplyThread: async (args) =>
      asReplyThread(unwrap(await adapter.messaging.fetchReplyThread(args))),
    sendReply: async (args) => {
      unwrap(await adapter.messaging.sendReply(args));
    },
    runCardAction: async (args) =>
      asCardAction(unwrap(await adapter.messaging.runCardAction(args)), args),
  };
}
