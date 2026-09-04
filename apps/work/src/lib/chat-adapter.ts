/**
 * Web bridges from the PlatformAdapter result contract to the packages/ui
 * chat seams (US-007).
 *
 * packages/ui components take structural ChatSidebarApi / NotificationsApi /
 * AgencyApi interfaces and expect plain throwing promises; the platform
 * adapter returns AdapterResult unions. These bridges unwrap results and
 * throw on `unavailable` / `error` so the ported optimistic-rollback and
 * error-classification logic keeps working unchanged.
 */

import type { AdapterResult, PlatformAdapter } from "@hq/platform";
import {
  createLiveNotificationsApi,
  normalizeDirectoryFeed,
  type AgencyApi,
  type AgencyMessage,
  type AgencyQuestion,
  type AgencyTeam,
  type ChannelDetailResponse,
  type ChannelDirectoryRow,
  type ChannelsResponse,
  type ChatSidebarApi,
  type ContactsResponse,
  type ConversationApi,
  type ConversationMessageWire,
  type DmContactInput,
  type DmThreadResponse,
  type MessageSearchResult,
  type NotificationsApi,
  type ReplyThreadResponse,
  type RequestsResponse,
  type Workspace,
} from "@hq/ui";
import {
  mergeShallowCache,
  readShallowCache,
  writeShallowCache,
} from "./browser-cache.js";
import { hqProFetch, type HqProFetch } from "./hq-pro-client.js";
import {
  applyHonestDirectoryActivity,
  mergeLiveContacts,
  mergeWorkProjectsIntoDirectory,
  parseInboxPage,
  parseWorkFeed,
  type WorkFeedItem,
} from "./live-sidebar.js";

function unwrap<T>(result: AdapterResult<T>): T {
  if (result.ok) return result.value;
  // Keep the machine code (e.g. "http-404", "http-401") in the thrown
  // message: packages/ui error classifiers (classifyNotificationsError)
  // pattern-match on it to pick the absent-safe empty/auth states.
  const detail = result.message ?? result.reason;
  throw new Error(result.code ? `[${result.code}] ${detail}` : detail);
}

async function call<T>(p: Promise<AdapterResult<unknown>>): Promise<T> {
  return unwrap(await p) as T;
}

const INBOX_PAGE_LIMIT = 50;
const INBOX_HYDRATE_PAGES = 2;
const WORK_FEED_TTL_MS = 60_000;

export interface HydratedRail {
  directory: ChannelDirectoryRow[];
  contacts: DmContactInput[];
}

export interface LiveRailDeps {
  fetch?: HqProFetch;
}

let workFeedCache: {
  key: string;
  at: number;
  items: WorkFeedItem[];
} | null = null;
let railHydrate: { key: string; promise: Promise<HydratedRail> } | null = null;

/** Reconciler snapshot marker — never send this to GET /v1/notify/channels. */
const SYNTHETIC_LIVEFEED_PREFIX = "livefeed";

function isPagedDirectoryCursor(cursor: string | undefined): cursor is string {
  return (
    typeof cursor === "string" &&
    cursor.length > 0 &&
    !cursor.startsWith(SYNTHETIC_LIVEFEED_PREFIX)
  );
}

async function loadWorkFeed(
  personUid: string,
  fetchImpl: HqProFetch = hqProFetch,
): Promise<WorkFeedItem[]> {
  const now = Date.now();
  if (
    workFeedCache?.key === personUid &&
    now - workFeedCache.at < WORK_FEED_TTL_MS
  ) {
    return workFeedCache.items;
  }
  try {
    const res = await fetchImpl("/v1/work-mesh/work");
    if (!res.ok) {
      return workFeedCache?.key === personUid ? workFeedCache.items : [];
    }
    const items = parseWorkFeed(await res.json());
    workFeedCache = { key: personUid, at: now, items };
    return items;
  } catch {
    return workFeedCache?.key === personUid ? workFeedCache.items : [];
  }
}

function contactsFromRaw(raw: unknown): DmContactInput[] {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { contacts?: unknown })
      : null;
  const contacts = Array.isArray(rec?.contacts)
    ? rec.contacts
    : Array.isArray(raw)
      ? raw
      : [];
  return contacts as DmContactInput[];
}

async function loadInboxBundle(adapter: PlatformAdapter): Promise<{
  events: ReturnType<typeof parseInboxPage>["events"];
  pairUnreads: ReturnType<typeof parseInboxPage>["pairUnreads"];
  selfUid: string;
}> {
  const events: ReturnType<typeof parseInboxPage>["events"] = [];
  const pairUnreads: ReturnType<typeof parseInboxPage>["pairUnreads"] = [];
  let cursor: string | null = null;
  let selfUid = "";
  try {
    const who = await call<{ personUid?: string; uid?: string }>(
      adapter.identity.whoami(),
    );
    selfUid = (who.personUid ?? who.uid ?? "").trim();
  } catch {
    /* still merge; just cannot drop outbound self events */
  }
  for (let page = 0; page < INBOX_HYDRATE_PAGES; page += 1) {
    try {
      const parsed = parseInboxPage(
        await call<unknown>(
          adapter.notifications.fetchDmInbox({
            limit: String(INBOX_PAGE_LIMIT),
            ...(cursor ? { cursor } : {}),
          }),
        ),
      );
      events.push(...parsed.events);
      pairUnreads.push(...parsed.pairUnreads);
      if (!parsed.nextCursor) break;
      cursor = parsed.nextCursor;
    } catch {
      break;
    }
  }
  return { events, pairUnreads, selfUid };
}

/**
 * One snapshot of projects + chats + DMs. Directory and contacts callers
 * share this promise so the sidebar applies a single consistent rail.
 */
export function hydrateLiveRail(
  adapter: PlatformAdapter,
  previousDirectory: ChannelDirectoryRow[] = [],
  personUid = "",
  deps: LiveRailDeps = {},
): Promise<HydratedRail> {
  if (railHydrate?.key === personUid) return railHydrate.promise;
  const hydrate = (async () => {
    {
      const [dirResult, contactsResult, workItems, inbox] = await Promise.all([
        call<unknown>(adapter.messaging.fetchChannelDirectory(undefined)).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        call<unknown>(adapter.messaging.listContacts()).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        loadWorkFeed(personUid, deps.fetch ?? hqProFetch),
        loadInboxBundle(adapter),
      ]);
      const contactsBase = contactsResult.ok
        ? contactsFromRaw(contactsResult.value)
        : readShallowCache(personUid).contacts;
      if (!dirResult.ok) {
        if (previousDirectory.length === 0) {
          throw dirResult.error;
        }
        const contacts = mergeLiveContacts(
          contactsBase,
          inbox.events,
          inbox.pairUnreads,
          inbox.selfUid,
        );
        const directory = applyHonestDirectoryActivity(
          previousDirectory,
          workItems,
          previousDirectory,
        );
        if (personUid) {
          writeShallowCache(
            mergeShallowCache(
              readShallowCache(personUid),
              {
                directory,
                contacts: contactsResult.ok ? contacts : undefined,
              },
              personUid,
            ),
          );
        }
        return {
          directory,
          contacts,
        };
      }
      const feed = normalizeDirectoryFeed(dirResult.value);
      const directory = mergeWorkProjectsIntoDirectory(
        applyHonestDirectoryActivity(
          feed.rows ?? [],
          workItems,
          previousDirectory,
        ),
        workItems,
      );
      const contacts = mergeLiveContacts(
        contactsBase,
        inbox.events,
        inbox.pairUnreads,
        inbox.selfUid,
      );
      if (personUid) {
        writeShallowCache(
          mergeShallowCache(
            readShallowCache(personUid),
            { directory, contacts: contactsResult.ok ? contacts : undefined },
            personUid,
          ),
        );
      }
      return { directory, contacts };
    }
  })();
  const entry = { key: personUid, promise: hydrate };
  railHydrate = entry;
  void hydrate.then(
    () => {
      if (railHydrate === entry) railHydrate = null;
    },
    () => {
      if (railHydrate === entry) railHydrate = null;
    },
  );
  return hydrate;
}

export function resetLiveRailHydrate(): void {
  railHydrate = null;
  workFeedCache = null;
}

/**
 * PlatformAdapter promises a bare array for search results. The web adapter
 * predates that contract and still returns its API envelope, so absorb both
 * forms at this UI boundary without changing the hosted adapter response.
 */
function asMessageSearchResult(value: unknown): MessageSearchResult {
  if (Array.isArray(value)) {
    return { results: value as MessageSearchResult["results"] };
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  return {
    results: Array.isArray(record?.results)
      ? (record.results as MessageSearchResult["results"])
      : [],
  };
}

export function createChatSidebarApi(
  adapter: PlatformAdapter,
  previousDirectory: ChannelDirectoryRow[] = [],
  personUid = "",
  deps: LiveRailDeps = {},
): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (cursor) => {
      const pageCursor = cursor ?? undefined;
      if (isPagedDirectoryCursor(pageCursor)) {
        return normalizeDirectoryFeed(
          await call<unknown>(
            adapter.messaging.fetchChannelDirectory(pageCursor),
          ),
        );
      }
      const rail = await hydrateLiveRail(
        adapter,
        previousDirectory,
        personUid,
        deps,
      );
      return normalizeDirectoryFeed({
        snapshot: true,
        cursor: "livefeed0000000000000000000000000000",
        cursorExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        rows: rail.directory,
      });
    },
    listContacts: async () => {
      const rail = await hydrateLiveRail(
        adapter,
        previousDirectory,
        personUid,
        deps,
      );
      return { contacts: rail.contacts };
    },
    // `listContacts()` without a companyUid is the global compose feed and
    // carries no companyUid per row. CreateModal needs this scoped roster to
    // distinguish a teammate from an outside invitee before creating a
    // company channel. Older Tauri stubs return a bare array while the live
    // endpoint returns `{ contacts: [...] }`, so retain both wire shapes.
    listCompanyMembers: async (companyUid) => ({
      contacts: contactsFromRaw(
        await call<unknown>(adapter.messaging.listContacts({ companyUid })),
      ),
    }),
    listDmRequests: async () => ({
      requests: await call<NonNullable<RequestsResponse["requests"]>>(
        adapter.messaging.listDmRequests(),
      ),
    }),
    listChannels: async (args) => {
      const native = await call<
        ChannelsResponse | NonNullable<ChannelsResponse["channels"]>
      >(adapter.messaging.listChannels(args));
      return Array.isArray(native) ? { channels: native } : native;
    },
    fetchDmThread: (args) =>
      call<DmThreadResponse>(adapter.messaging.fetchDmThread(args)),
    markDmThreadRead: (withPersonUid) =>
      call<void>(adapter.messaging.markDmThreadRead(withPersonUid)),
    markChannelRead: (channelId) =>
      call<void>(adapter.messaging.markChannelRead(channelId)),
    searchMessages: async (args) =>
      asMessageSearchResult(
        await call<unknown>(
          adapter.messaging.searchMessages(args.q, {
            ...(args.companyUid ? { companyUid: args.companyUid } : {}),
            ...(args.limit != null ? { limit: args.limit } : {}),
          }),
        ),
      ),
    createChannel: async (args) => {
      const value = await call<Record<string, unknown>>(
        adapter.messaging.createChannel(args as never),
      );
      const channel =
        value && typeof value === "object" && "channel" in value
          ? (value.channel as Record<string, unknown>)
          : value;
      const channelId =
        channel && typeof channel.channelId === "string"
          ? channel.channelId
          : "";
      if (!channelId) throw new Error("Channel created without an id");
      return { channelId };
    },
    addChannelMember: async (channelId, toPersonUid) => {
      await call<unknown>(
        adapter.messaging.addChannelMember(channelId, toPersonUid),
      );
    },
    sendChannelMessage: async (args) => {
      await call<unknown>(
        adapter.messaging.sendChannelMessage(args.channelId, args.body, {}),
      );
    },
    sendDm: async (args) => {
      await call<unknown>(
        adapter.messaging.sendDm(args.toPersonUid, args.body, {}),
      );
    },
  };
}

function asReplyThread(value: unknown): ReplyThreadResponse {
  const rec =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const root =
    rec.root && typeof rec.root === "object" && !Array.isArray(rec.root)
      ? (rec.root as ConversationMessageWire)
      : null;
  const replies = Array.isArray(rec.replies)
    ? (rec.replies as ConversationMessageWire[])
    : [];
  const rootCount =
    root && typeof root.replyCount === "number" ? root.replyCount : undefined;
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

export function createConversationApi(
  adapter: PlatformAdapter,
): ConversationApi {
  return {
    fetchChannel: (args) =>
      call<ChannelDetailResponse>(adapter.messaging.fetchChannel(args)),
    sendChannelMessage: (args) =>
      call<void>(
        adapter.messaging.sendChannelMessage(args.channelId, args.body, {
          mentions: args.mentions,
          attachments: args.attachments,
        }),
      ),
    fetchDmThread: (args) =>
      call<DmThreadResponse>(adapter.messaging.fetchDmThread(args)),
    sendDm: (args) =>
      call<void>(
        adapter.messaging.sendDm(args.toPersonUid, args.body, {
          attachments: args.attachments,
        }),
      ),
    fetchReplyThread: async (args) =>
      asReplyThread(
        await call<unknown>(adapter.messaging.fetchReplyThread(args)),
      ),
    sendReply: (args) => call<void>(adapter.messaging.sendReply(args)),
    runCardAction: async (args) => {
      const raw = await call<Record<string, unknown>>(
        adapter.messaging.runCardAction(args),
      );
      return {
        cardId: typeof raw.cardId === "string" ? raw.cardId : args.cardId,
        actionId: typeof raw.actionId === "string" ? raw.actionId : args.actionId,
        eventId: typeof raw.eventId === "string" ? raw.eventId : undefined,
        state: typeof raw.state === "string" ? raw.state : "",
        fields: raw.fields,
        replayed: raw.replayed === true,
      };
    },
    getCompanyTab: adapter.messaging.getCompanyTab
      ? async (companyUid, tab) =>
          call(adapter.messaging.getCompanyTab!(companyUid, tab))
      : undefined,
    runCompanyTabAction: adapter.messaging.runCompanyTabAction
      ? async (args) => {
          const raw = await call<Record<string, unknown>>(
            adapter.messaging.runCompanyTabAction!(args),
          );
          return {
            cardId: typeof raw.cardId === "string" ? raw.cardId : args.cardId,
            actionId:
              typeof raw.actionId === "string" ? raw.actionId : args.actionId,
            eventId: typeof raw.eventId === "string" ? raw.eventId : undefined,
            state: typeof raw.state === "string" ? raw.state : "",
            fields: raw.fields,
            replayed: raw.replayed === true,
          };
        }
      : undefined,
  };
}

/** Workspace memberships for the sidebar's company scope + admin gating. */
export async function fetchWorkspaces(
  adapter: PlatformAdapter,
): Promise<Workspace[]> {
  return call<Workspace[]>(adapter.identity.listWorkspaces());
}

export function createNotificationsApi(
  adapter: PlatformAdapter,
): NotificationsApi {
  return createLiveNotificationsApi(adapter);
}

export function createAgencyApi(adapter: PlatformAdapter): AgencyApi {
  return {
    listTeams: () => call<AgencyTeam[]>(adapter.agency.listTeams()),
    listQuestions: () => call<AgencyQuestion[]>(adapter.agency.listQuestions()),
    listChat: (_company, team) =>
      call<AgencyMessage[]>(adapter.agency.listChat(team)),
    answerQuestion: async (args) => {
      await call<void>(
        adapter.agency.answerQuestion(args.id, { answer: args.answer }),
      );
      return "delivered";
    },
    sendMessage: async (args) => {
      await call<void>(
        adapter.agency.sendMessage(args.team, { text: args.text }),
      );
      return "delivered";
    },
  };
}
