/**
 * Connection cards in a cloud bot's direct message: the pure model.
 *
 * A bot's message can offer to connect Slack or the company's tools (a
 * `connect` block, see richMessageContent.ts). Each target draws as one card
 * with four states: offered, connecting, connected, declined. Everything that
 * decides what a card says lives here, so it is testable without Svelte.
 *
 * WHAT IS STORED. Only what the person did on this device: they pressed
 * Connect (and when), they said "Not now" (and when), they let the bot use a
 * connection. "connected" is never stored. It is always read from the server:
 * the bot's status for Slack, the company's connection list for tools. A card
 * can therefore never claim a connection the server does not have.
 *
 * Every word on a card and every link it opens is written by the app. Nothing
 * here reads text, a link or a style from the bot.
 */

import type { ConnectTarget } from "./richMessageContent.js";

export type ConnectionCardState = "offered" | "connecting" | "connected" | "declined";

export type ConnectionCardAction = "connect" | "decline" | "allow";

/** Storage key of the per-bot record. */
export const BOT_CONNECTION_CARDS_STORAGE_KEY = "hq.chat.botConnectionCards.v1";

/** A card left "connecting" this long goes back to offered, with a reason. */
export const CONNECTING_TIMEOUT_MS = 10 * 60_000;

/** How many bots the record keeps, newest first. */
export const MAX_BOT_CONNECTION_RECORDS = 50;

const MAX_WAITING_ROWS = 4;
const MAX_USABLE_NAMES = 6;
const MAX_REMEMBERED_IDS = 200;

export interface SlackCardRecord {
  state: "connecting" | "declined";
  /** When the person pressed the button (ms). */
  since: number;
  /** The bot has been told Slack is connected. */
  announced?: boolean;
}

export interface ToolsCardRecord {
  state: "connecting" | "declined";
  since: number;
  /** Connection ids that existed when the person pressed Connect. */
  baselineIds?: string[];
}

/** What this device remembers about one bot's cards. */
export interface BotConnectionRecord {
  /** The bot's first message, the one the cards sit under. */
  helloEventId?: string;
  slack?: SlackCardRecord;
  tools?: ToolsCardRecord;
  /** Connections the person let the bot use from here (connection id → name). */
  granted?: Record<string, { name: string; at: number }>;
  /** Connection ids the bot has been told about. */
  announced?: string[];
}

export type BotConnectionRecords = Record<string, BotConnectionRecord>;

type RecordStorage = Pick<Storage, "getItem" | "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const id = text(entry);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_REMEMBERED_IDS) break;
  }
  return out;
}

function cardState(value: unknown): "connecting" | "declined" | null {
  return value === "connecting" || value === "declined" ? value : null;
}

function finiteTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanBotRecord(raw: unknown): BotConnectionRecord | null {
  if (!isRecord(raw)) return null;
  const out: BotConnectionRecord = {};
  const hello = text(raw.helloEventId);
  if (hello) out.helloEventId = hello;
  if (isRecord(raw.slack)) {
    const state = cardState(raw.slack.state);
    const since = finiteTime(raw.slack.since);
    if (state && since !== null) {
      out.slack = { state, since, ...(raw.slack.announced === true ? { announced: true } : {}) };
    }
  }
  if (isRecord(raw.tools)) {
    const state = cardState(raw.tools.state);
    const since = finiteTime(raw.tools.since);
    if (state && since !== null) {
      out.tools = {
        state,
        since,
        ...(Array.isArray(raw.tools.baselineIds) ? { baselineIds: stringList(raw.tools.baselineIds) } : {}),
      };
    }
  }
  if (isRecord(raw.granted)) {
    const granted: Record<string, { name: string; at: number }> = {};
    for (const [id, entry] of Object.entries(raw.granted)) {
      if (!id.trim() || !isRecord(entry)) continue;
      granted[id] = { name: text(entry.name) || id, at: finiteTime(entry.at) ?? 0 };
    }
    if (Object.keys(granted).length > 0) out.granted = granted;
  }
  const announced = stringList(raw.announced);
  if (announced.length > 0) out.announced = announced;
  return out;
}

/**
 * Read the per-bot records. Missing, malformed or unreadable storage is an
 * empty record; a malformed entry is dropped. Never throws.
 */
export function loadConnectionRecords(storage: RecordStorage | null | undefined): BotConnectionRecords {
  try {
    const raw = storage?.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const out: BotConnectionRecords = {};
    for (const [uid, entry] of Object.entries(parsed)) {
      if (Object.keys(out).length >= MAX_BOT_CONNECTION_RECORDS) break;
      if (!uid.startsWith("agt_")) continue;
      const record = cleanBotRecord(entry);
      if (record) out[uid] = record;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the per-bot records. Best effort: a full or blocked storage is ignored. */
export function saveConnectionRecords(storage: RecordStorage | null | undefined, records: BotConnectionRecords): void {
  try {
    storage?.setItem(BOT_CONNECTION_CARDS_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // best-effort
  }
}

/**
 * Put one bot's record in, newest first, and keep at most
 * {@link MAX_BOT_CONNECTION_RECORDS} bots. Returns a new object.
 */
export function withBotRecord(
  records: BotConnectionRecords,
  agentUid: string,
  record: BotConnectionRecord,
): BotConnectionRecords {
  const uid = agentUid.trim();
  if (!uid) return records;
  const out: BotConnectionRecords = { [uid]: record };
  for (const [other, entry] of Object.entries(records)) {
    if (other === uid) continue;
    if (Object.keys(out).length >= MAX_BOT_CONNECTION_RECORDS) break;
    out[other] = entry;
  }
  return out;
}

/** Forget one bot. Returns the same object when the bot was not there. */
export function withoutBotRecord(records: BotConnectionRecords, agentUid: string): BotConnectionRecords {
  if (!(agentUid in records)) return records;
  const { [agentUid]: _gone, ...rest } = records;
  return rest;
}

// ── What the person did ──────────────────────────────────────────────────

/**
 * The person pressed Connect (or "Open again", which restarts the wait).
 *
 * Tools take a baseline: the connection ids that exist now, so the card can
 * tell a tool connected after the press from one that was already there. Pass
 * the ids for a fresh press, `"keep"` for "Open again" (a tool connected
 * between the two presses is still new), or null when the list is unknown:
 * with no baseline nothing counts as new, so nothing is announced by mistake.
 */
export function markConnecting(
  record: BotConnectionRecord | null | undefined,
  target: ConnectTarget,
  now: number,
  baseline?: readonly string[] | "keep" | null,
): BotConnectionRecord {
  const base = record ?? {};
  if (target === "slack") {
    return { ...base, slack: { state: "connecting", since: now, ...(base.slack?.announced ? { announced: true } : {}) } };
  }
  const baselineIds =
    baseline === "keep" ? base.tools?.baselineIds : baseline ? stringList([...baseline]) : undefined;
  return { ...base, tools: { state: "connecting", since: now, ...(baselineIds ? { baselineIds } : {}) } };
}

/**
 * The person pressed "Not now". For tools the baseline goes too: after a
 * "Not now" no later connection counts as the answer to this card.
 */
export function markDeclined(
  record: BotConnectionRecord | null | undefined,
  target: ConnectTarget,
  now: number,
): BotConnectionRecord {
  const base = record ?? {};
  if (target === "slack") {
    return { ...base, slack: { state: "declined", since: now, ...(base.slack?.announced ? { announced: true } : {}) } };
  }
  return { ...base, tools: { state: "declined", since: now } };
}

/** The person let the bot use a connection, and the server accepted it. */
export function recordGrant(
  record: BotConnectionRecord | null | undefined,
  connectionId: string,
  name: string,
  now: number,
): BotConnectionRecord {
  const base = record ?? {};
  return { ...base, granted: { ...(base.granted ?? {}), [connectionId]: { name, at: now } } };
}

/** The bot has been told about this connection. */
export function markToolAnnounced(
  record: BotConnectionRecord | null | undefined,
  connectionId: string,
): BotConnectionRecord {
  const base = record ?? {};
  if (base.announced?.includes(connectionId)) return base;
  return { ...base, announced: [connectionId, ...(base.announced ?? [])].slice(0, MAX_REMEMBERED_IDS) };
}

/** The bot has been told it is in Slack. */
export function markSlackAnnounced(record: BotConnectionRecord | null | undefined): BotConnectionRecord {
  const base = record ?? {};
  if (!base.slack || base.slack.announced) return base;
  return { ...base, slack: { ...base.slack, announced: true } };
}

// ── Server facts ─────────────────────────────────────────────────────────

export interface SlackFacts {
  state: "connected" | "pending" | "none";
  /** One sentence on why Slack is set up but not working yet. */
  note?: string;
}

function agentOf(json: unknown): Record<string, unknown> | null {
  const root = isRecord(json) ? json : null;
  if (!root) return null;
  return isRecord(root.agent) ? root.agent : root;
}

/**
 * Read Slack from a bot's status answer (`GET /v1/agents/{uid}/status`).
 *
 * "Connected" means the bot can receive a message in Slack and answer it. An
 * app that is installed but cannot receive is not connected, so only the two
 * capabilities that mean "messages arrive" count. Every field may be missing.
 */
export function slackFactsFromStatus(json: unknown, botName?: string | null): SlackFacts {
  const agent = agentOf(json);
  if (!agent) return { state: "none" };
  const diagnostics = isRecord(agent.channelDiagnostics) ? agent.channelDiagnostics : null;
  const slack = isRecord(diagnostics?.slack) ? diagnostics.slack : null;
  const capability = text(slack?.inboundCapability);
  if (capability === "ok" || capability === "socket-mode") return { state: "connected" };
  const channels = isRecord(agent.channels) ? agent.channels : null;
  const configured = channels?.slack !== undefined && channels.slack !== null && channels.slack !== false;
  if (!configured) return { state: "none" };
  const bot = botName?.trim() || "your bot";
  return {
    state: "pending",
    note:
      capability === "pending-install"
        ? "Waiting for the app to be approved in Slack."
        : `Slack is set up but ${bot} cannot receive messages there yet.`,
  };
}

/** The company a bot belongs to, from its status answer. */
export function companyUidFromStatus(json: unknown): string | null {
  const uid = text(agentOf(json)?.companyUid);
  return uid.startsWith("cmp_") ? uid : null;
}

export interface ToolConnection {
  id: string;
  /** Display name, e.g. "Linear". */
  name: string;
  /** Provider without the `factory:` prefix, e.g. "linear". */
  provider: string;
  createdAt: string;
  /** Connected after the person pressed Connect on the card. */
  isNew: boolean;
  /** Usable because the person allowed it from here, not because it is open to all. */
  granted: boolean;
  /** The person looking at the card connected it (or the list does not say who did). */
  byViewer: boolean;
}

export interface ToolFacts {
  /** Connections the bot can use. */
  usable: ToolConnection[];
  /** Connected, but the bot may not use them until someone allows it. Newest first. */
  waiting: ToolConnection[];
  /** Only owners and admins can add apps. */
  canConnect: boolean;
  /** Every connected connection's id. The baseline taken when Connect is pressed. */
  ids: string[];
}

function providerSlug(provider: string): string {
  return provider.replace(/^factory:/i, "").trim();
}

function connectionName(raw: Record<string, unknown>, slug: string): string {
  const installed = isRecord(raw.installation) ? text(raw.installation.displayName) : "";
  if (installed) return installed;
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "App";
}

/**
 * Read the company's connections (`GET /v1/integrations/admin?companyUid=`)
 * for one bot. A connection open to everyone is usable as it is; a private or
 * shared one is usable only once the person allowed it from this device,
 * because the list does not say who it is shared with. Anything else (a mode
 * this version does not know, a revoked or failing connection) is left out:
 * the card never claims a tool the bot may not be able to use.
 */
export function toolFacts(json: unknown, record: BotConnectionRecord | null | undefined): ToolFacts {
  const root = isRecord(json) ? json : null;
  const viewer = isRecord(root?.viewer) ? root.viewer : null;
  const canConnect = viewer?.canManageIntegrations === true;
  const viewerUid = text(viewer?.personUid);
  const baseline = record?.tools?.baselineIds;
  const usable: ToolConnection[] = [];
  const waiting: ToolConnection[] = [];
  const ids: string[] = [];
  for (const raw of Array.isArray(root?.connections) ? root.connections : []) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id);
    if (!id || ids.includes(id) || raw.status !== "connected") continue;
    ids.push(id);
    const provider = providerSlug(text(raw.provider));
    const mode = isRecord(raw.access) ? text(raw.access.mode) : "";
    const granted = Boolean(record?.granted?.[id]);
    const createdBy = text(raw.createdBy);
    const connection: ToolConnection = {
      id,
      name: connectionName(raw, provider),
      provider,
      createdAt: text(raw.createdAt),
      isNew: baseline ? !baseline.includes(id) : false,
      granted,
      byViewer: !createdBy || !viewerUid || createdBy === viewerUid,
    };
    if (mode === "everyone" || mode === "legacy-open") usable.push({ ...connection, granted: false });
    else if (granted) usable.push(connection);
    else if (mode === "private" || mode === "shared") waiting.push(connection);
  }
  waiting.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { usable, waiting, canConnect, ids };
}

/**
 * What the bot should be told now. Slack: once, when it turns connected after
 * the person pressed Connect on its card. Tools: once per connection the bot
 * can use, either allowed from here or open to everyone and connected by this
 * person after they pressed Connect (the notice says "{person} just connected",
 * so a teammate's connection is not announced in their name). Never a
 * connection the bot cannot use.
 */
export function pendingAnnouncements(
  record: BotConnectionRecord | null | undefined,
  slack: SlackFacts | null | undefined,
  tools: ToolFacts | null | undefined,
): { slack: boolean; tools: ToolConnection[] } {
  const slackDue =
    slack?.state === "connected" && record?.slack?.state === "connecting" && record.slack.announced !== true;
  const told = record?.announced ?? [];
  const toolsDue = (tools?.usable ?? []).filter(
    (c) => (c.granted || (c.isNew && c.byViewer)) && !told.includes(c.id),
  );
  return { slack: slackDue, tools: toolsDue };
}

// ── The view ─────────────────────────────────────────────────────────────

/** Stable name of one button press, for the "already pressed" bookkeeping. */
export function connectionActionKey(
  target: ConnectTarget,
  action: ConnectionCardAction,
  connectionId?: string | null,
): string {
  return `${target}:${action}${connectionId ? `:${connectionId}` : ""}`;
}

export interface ConnectionCardRow {
  connectionId: string;
  name: string;
  /** The row's button, e.g. "Let Nova use it". */
  label: string;
  /** The press is on its way to the server: the button is disabled. */
  pending: boolean;
  isNew: boolean;
}

/** Everything a card draws. Built by {@link connectionCardView}. */
export interface ConnectionCardView {
  target: ConnectTarget;
  state: ConnectionCardState;
  title: string;
  line: string;
  /** Main button, or null when the state has none. */
  primaryLabel: string | null;
  /** The main button's action is in flight: it is disabled. */
  primaryPending: boolean;
  /** "Not now", or null. */
  declineLabel: string | null;
  /** "Connected" once it is, else null. */
  mark: string | null;
  /** One sentence under the card: a failure, a timeout, a server reason. */
  note: string | null;
  /** Tools: names of the connections the bot can use. */
  usable: string[];
  /** Tools: connections the person can let the bot use, at most four. */
  waiting: ConnectionCardRow[];
  /** Tools: "+N more in HQ Integrations" when rows were left out. */
  moreWaiting: string | null;
}

export interface ConnectionCardInput {
  /** The bot's display name, written into the copy. */
  botName: string;
  record?: BotConnectionRecord | null;
  /** null while unknown (not loaded, or the load failed). */
  slack?: SlackFacts | null;
  tools?: ToolFacts | null;
  now: number;
  /**
   * When the message carrying the card was written (ms). A card in a message
   * newer than a "Not now" is a new offer and shows as offered again.
   */
  messageAt?: number | null;
  /** Action keys ({@link connectionActionKey}) on their way to the server. */
  inFlight?: ReadonlySet<string> | null;
  /** A sentence the host wants shown: a failed grant, a failed load. */
  notes?: Partial<Record<ConnectTarget, string | null>> | null;
}

export const SLACK_TIMEOUT_NOTE = "Slack was not connected. You can try again any time.";
export const TOOLS_TIMEOUT_NOTE = "No new tool was connected. You can try again any time.";

function timedOut(since: number, now: number): boolean {
  return now - since > CONNECTING_TIMEOUT_MS;
}

/** A "Not now" still stands unless this card is in a message written after it. */
function declineStands(since: number, messageAt: number | null | undefined): boolean {
  return !(typeof messageAt === "number" && Number.isFinite(messageAt) && messageAt > since);
}

function slackView(input: ConnectionCardInput): ConnectionCardView {
  const bot = input.botName.trim() || "your bot";
  const entry = input.record?.slack;
  const facts = input.slack ?? null;
  const hostNote = input.notes?.slack?.trim() || null;
  const base = {
    target: "slack" as const,
    title: "Slack",
    primaryPending: Boolean(input.inFlight?.has(connectionActionKey("slack", "connect"))),
    usable: [],
    waiting: [],
    moreWaiting: null,
  };
  if (facts?.state === "connected") {
    return {
      ...base,
      state: "connected",
      line: `${bot} is in Slack.`,
      primaryLabel: null,
      primaryPending: false,
      declineLabel: null,
      mark: "Connected",
      note: null,
    };
  }
  if (entry?.state === "declined" && declineStands(entry.since, input.messageAt)) {
    return {
      ...base,
      state: "declined",
      line: `Not connected. Ask ${bot} about Slack any time.`,
      primaryLabel: null,
      primaryPending: false,
      declineLabel: null,
      mark: null,
      note: null,
    };
  }
  const pendingNote = facts?.state === "pending" ? (facts.note ?? null) : null;
  if (entry?.state === "connecting" && !timedOut(entry.since, input.now)) {
    return {
      ...base,
      state: "connecting",
      line: "Finish in your browser. This card updates when Slack is connected.",
      primaryLabel: "Open again",
      declineLabel: "Not now",
      mark: null,
      note: hostNote ?? pendingNote,
    };
  }
  return {
    ...base,
    state: "offered",
    line: `Talk to ${bot} in Slack and let it post there.`,
    primaryLabel: "Connect Slack",
    declineLabel: "Not now",
    mark: null,
    note: hostNote ?? pendingNote ?? (entry?.state === "connecting" ? SLACK_TIMEOUT_NOTE : null),
  };
}

function usableLine(bot: string, names: string[]): string {
  const shown = names.slice(0, MAX_USABLE_NAMES).join(", ");
  const more = names.length - MAX_USABLE_NAMES;
  return more > 0 ? `${bot} can use: ${shown} and ${more} more.` : `${bot} can use: ${shown}.`;
}

function toolsView(input: ConnectionCardInput): ConnectionCardView {
  const bot = input.botName.trim() || "your bot";
  const entry = input.record?.tools;
  const facts = input.tools ?? null;
  const hostNote = input.notes?.tools?.trim() || null;
  // Until the list has loaded nobody knows who may add apps. Offer the button;
  // the page it opens says so itself when the person may not.
  const canConnect = facts ? facts.canConnect : true;
  const usable = facts?.usable ?? [];
  const allWaiting = facts?.waiting ?? [];
  const waiting: ConnectionCardRow[] = allWaiting.slice(0, MAX_WAITING_ROWS).map((c) => ({
    connectionId: c.id,
    name: c.name,
    label: `Let ${bot} use it`,
    pending: Boolean(input.inFlight?.has(connectionActionKey("tools", "allow", c.id))),
    isNew: c.isNew,
  }));
  const left = allWaiting.length - waiting.length;
  const base = {
    target: "tools" as const,
    title: "Connect your tools",
    primaryPending: Boolean(input.inFlight?.has(connectionActionKey("tools", "connect"))),
    usable: usable.map((c) => c.name),
    waiting,
    moreWaiting: left > 0 ? `+${left} more in HQ Integrations` : null,
  };
  const somethingNew = usable.some((c) => c.isNew) || allWaiting.some((c) => c.isNew);
  if (entry?.state === "connecting" && !timedOut(entry.since, input.now) && !somethingNew) {
    return {
      ...base,
      state: "connecting",
      line: "Finish in your browser. This card updates when a tool is connected.",
      primaryLabel: "Open again",
      declineLabel: "Not now",
      mark: null,
      note: hostNote,
    };
  }
  if (usable.length > 0) {
    return {
      ...base,
      state: "connected",
      line: usableLine(bot, base.usable),
      primaryLabel: canConnect ? "Connect another" : null,
      declineLabel: null,
      mark: "Connected",
      note: hostNote,
    };
  }
  if (entry?.state === "declined" && declineStands(entry.since, input.messageAt)) {
    return {
      ...base,
      state: "declined",
      line: `No tools connected. Ask ${bot} any time.`,
      primaryLabel: null,
      primaryPending: false,
      declineLabel: null,
      mark: null,
      note: null,
      waiting: [],
      moreWaiting: null,
    };
  }
  const timeoutNote = entry?.state === "connecting" && !somethingNew ? TOOLS_TIMEOUT_NOTE : null;
  if (!canConnect) {
    return {
      ...base,
      state: "offered",
      line: "Ask a company admin to connect apps in HQ Integrations.",
      primaryLabel: null,
      primaryPending: false,
      declineLabel: null,
      mark: null,
      note: hostNote,
    };
  }
  return {
    ...base,
    state: "offered",
    line: `Add any app through HQ Integrations so ${bot} can work with it.`,
    primaryLabel: "Connect a tool",
    declineLabel: "Not now",
    mark: null,
    note: hostNote ?? timeoutNote,
  };
}

/** Build what one card draws. Pure: same input, same view. */
export function connectionCardView(target: ConnectTarget, input: ConnectionCardInput): ConnectionCardView {
  return target === "slack" ? slackView(input) : toolsView(input);
}

// ── What the components pass around ──────────────────────────────────────

/** One button press on a card, as the host receives it. */
export interface ConnectionCardActionDetail {
  target: ConnectTarget;
  action: ConnectionCardAction;
  /** The connection of an "allow" row. */
  connectionId?: string;
}

export type ConnectionCardActionHandler = (detail: ConnectionCardActionDetail) => void | Promise<void>;

/** The cards of one message: a view per target, and where presses go. */
export interface ConnectionCards {
  views: Partial<Record<ConnectTarget, ConnectionCardView>>;
  onaction: ConnectionCardActionHandler;
}

/**
 * The cards of a whole conversation. The views are built per message, because
 * a card in a message written after a "Not now" is a new offer.
 */
export interface ConversationConnectionCards {
  viewsFor: (message: { eventId: string; createdAt?: string | null }) => Partial<Record<ConnectTarget, ConnectionCardView>>;
  onaction: ConnectionCardActionHandler;
}
