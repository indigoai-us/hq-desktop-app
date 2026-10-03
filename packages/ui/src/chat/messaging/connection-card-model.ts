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

import type { BrandMark } from "./app-brand-marks.js";
import type { ConnectTarget } from "./richMessageContent.js";
import { slackCapabilityFromStatus, slackRowFromStatus, slackRowStage, type SlackPendingStage } from "./slack-status.js";

export type ConnectionCardState = "offered" | "connecting" | "connected" | "declined";

/**
 * Which card: one of the built-in cards, or an integration card. An
 * integration card is further named by its `domain` (see
 * {@link ConnectionCardView}); there is one such card per app.
 */
export type ConnectionCardTarget = ConnectTarget | "integration";

/**
 * What a button on a card does. `open` opens the card's own modal (see
 * {@link CARD_MODAL_TARGETS}); the others act at once.
 */
export type ConnectionCardAction = "connect" | "decline" | "allow" | "open";

/**
 * What a card's main button does: connect at once, open the card's modal, or
 * (an integration card that is connected but not shared) let the bot use it.
 */
export type ConnectionCardPrimaryAction = "connect" | "open" | "allow";

/** How an integration connects: with nothing, in the browser, or with a pasted key. */
export type IntegrationAuthClass = "none" | "oauth" | "key";

/**
 * The logo of an integration card: a bundled brand mark when the app has
 * one, else image sources tried in order, else the generic app glyph. There
 * is no badge made from the name: a card never shows a made-up logo.
 */
export interface ConnectionCardLogo {
  /** Image URLs the app built from the domain, tried in order. Never from the bot. */
  sources: string[];
}

/**
 * The cards whose main button opens a modal instead of connecting at once.
 *
 * This is the one place a target is marked as "has a modal". Add the target
  /** The app's bundled mark (app-brand-marks.ts), or null when it has none. */
  mark: BrandMark | null;
 * here and register its content in card-modal-registry.ts: the card's main
 * button then sends `open` and the shell shows that content in a CardModal.
 * A target listed here with no registered content has a button that does
 * nothing, so always do both.
 *
 * Slack connects in its modal (SlackConnectModal.svelte). The tools card
 * still opens a page in the browser.
 */
export const CARD_MODAL_TARGETS: ReadonlySet<ConnectTarget> = new Set<ConnectTarget>(["slack"]);

/** Whether a card's main button opens its modal. */
export function cardOpensModal(
  target: ConnectTarget,
  modalTargets: ReadonlySet<ConnectTarget> | null | undefined = CARD_MODAL_TARGETS,
): boolean {
  return (modalTargets ?? CARD_MODAL_TARGETS).has(target);
}

/** Storage key of the per-bot record. */
export const BOT_CONNECTION_CARDS_STORAGE_KEY = "hq.chat.botConnectionCards.v1";

/**
 * A card left "connecting" this long goes back to offered, with a reason.
 * For Slack this holds only while the server has no Slack set up for the
 * bot: once it has, the server is the truth and the card waits with it.
 */
export const CONNECTING_TIMEOUT_MS = 10 * 60_000;

/** How many bots the record keeps, newest first. */
export const MAX_BOT_CONNECTION_RECORDS = 50;

/**
 * How many of the person's own waiting connections a card lists. The list
 * scrolls inside the card, so this is a bound on the work, not on the height.
 */
export const MAX_WAITING_ROWS = 30;
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

/** What this device remembers about one integration card, by its domain. */
export interface AppCardRecord {
  state: "connecting" | "declined";
  /** When the person pressed the button (ms). */
  since: number;
}

/** What this device remembers about one bot's cards. */
export interface BotConnectionRecord {
  /** The bot's first message, the one the cards sit under. */
  helloEventId?: string;
  slack?: SlackCardRecord;
  tools?: ToolsCardRecord;
  /** The integration cards, by normalized domain. */
  apps?: Record<string, AppCardRecord>;
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
  if (isRecord(raw.apps)) {
    const apps: Record<string, AppCardRecord> = {};
    for (const [domain, entry] of Object.entries(raw.apps)) {
      if (!isRecord(entry) || Object.keys(apps).length >= MAX_REMEMBERED_IDS) continue;
      const key = domain.trim().toLowerCase();
      const state = cardState(entry.state);
      const since = finiteTime(entry.since);
      if (key && state && since !== null) apps[key] = { state, since };
    }
    if (Object.keys(apps).length > 0) out.apps = apps;
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

/** The person pressed Connect (or Open again) on an integration card. */
export function markAppConnecting(
  record: BotConnectionRecord | null | undefined,
  domain: string,
  now: number,
): BotConnectionRecord {
  const base = record ?? {};
  const key = domain.trim().toLowerCase();
  if (!key) return base;
  return { ...base, apps: { ...(base.apps ?? {}), [key]: { state: "connecting", since: now } } };
}

/** The person pressed "Not now" on an integration card. */
export function markAppDeclined(
  record: BotConnectionRecord | null | undefined,
  domain: string,
  now: number,
): BotConnectionRecord {
  const base = record ?? {};
  const key = domain.trim().toLowerCase();
  if (!key) return base;
  return { ...base, apps: { ...(base.apps ?? {}), [key]: { state: "declined", since: now } } };
}

/** An integration card's wait or decline is over (it connected): forget what was pressed. */
export function forgetAppCard(record: BotConnectionRecord | null | undefined, domain: string): BotConnectionRecord {
  const base = record ?? {};
  const key = domain.trim().toLowerCase();
  if (!base.apps || !(key in base.apps)) return base;
  const { [key]: _gone, ...rest } = base.apps;
  return Object.keys(rest).length > 0 ? { ...base, apps: rest } : (({ apps: _apps, ...withoutApps }) => withoutApps)(base);
}

// ── Server facts ─────────────────────────────────────────────────────────

export interface SlackFacts {
  state: "connected" | "pending" | "none";
  /**
   * `pending` only: what the setup is waiting for. The person approving the
   * bot in Slack, the person's token, or the bot's computer connecting.
   */
  stage?: SlackPendingStage;
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
 *
 * "Pending" means the server has Slack set up for the bot and it is not
 * connected yet. `stage` says what it is waiting for, read the same way the
 * Connect Slack modal reads it (slack-status.ts).
 */
export function slackFactsFromStatus(json: unknown): SlackFacts {
  const agent = agentOf(json);
  if (!agent) return { state: "none" };
  const capability = slackCapabilityFromStatus(json);
  if (capability === "ok" || capability === "socket-mode") return { state: "connected" };
  const channels = isRecord(agent.channels) ? agent.channels : null;
  const configured = channels?.slack !== undefined && channels.slack !== null && channels.slack !== false;
  if (!configured) return { state: "none" };
  const row = slackRowFromStatus(json);
  return { state: "pending", stage: row ? slackRowStage(row) : "finishing" };
}

/** The Slack card's one-line hint for what a setup that is not finished waits for. */
export function slackPendingHint(stage: SlackPendingStage | null | undefined, botName: string): string {
  const bot = botName.trim() || "your bot";
  if (stage === "approve") return `Approve ${bot} in Slack.`;
  if (stage === "token") return "Paste the token to finish.";
  return "Connecting.";
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
  /**
   * Connected by the person looking at the card, but the bot may not use them
   * until that person allows it. Newest first. A teammate's connection is
   * never here: see {@link toolFacts}.
   */
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
 *
 * Only the person's own connections wait for a "Let the bot use it" press:
 * the ones the list says they connected (`createdBy` is `viewer.personUid`).
 * A teammate's mailbox is not this person's to hand to a bot, so a connection
 * someone else made is not offered and not counted. When the list does not
 * say who is looking, or who connected it, the connection is not offered
 * either. This is stricter than `byViewer`, which gives the benefit of the
 * doubt because it only decides whose name goes on a notice.
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
    else if ((mode === "private" || mode === "shared") && viewerUid !== "" && createdBy === viewerUid) {
      waiting.push(connection);
    }
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

/**
 * Stable name of one button press, for the "already pressed" bookkeeping.
 * An integration card is named by its domain, so two apps never share a key.
 */
export function connectionActionKey(
  target: ConnectionCardTarget,
  action: ConnectionCardAction,
  connectionId?: string | null,
  domain?: string | null,
): string {
  return `${target}${domain ? `[${domain}]` : ""}:${action}${connectionId ? `:${connectionId}` : ""}`;
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

/**
 * Everything a card draws. Built by {@link connectionCardView} for the
 * built-in cards and by `integrationCardView` (integration-cards-model.ts)
 * for an app's card. The integration fields are set on that card only.
 */
export interface ConnectionCardView {
  target: ConnectionCardTarget;
  /** Set on an integration card. */
  kind?: "integration";
  /** The app's website domain, normalized. Integration cards only. */
  domain?: string;
  /** The app's logo: a bundled mark or image sources. Integration cards only; Slack keeps its drawn mark. */
  logo?: ConnectionCardLogo | null;
  /** How the app connects, when known. Integration cards only. */
  authClass?: IntegrationAuthClass | null;
  /** The connection a card's "Let {bot} use it" button shares. Integration cards only. */
  connectionId?: string | null;
  state: ConnectionCardState;
  /** The card's name: "Slack", "Connect your tools", or the app's name. */
  title: string;
  line: string;
  /** Main button, or null when the state has none. */
  primaryLabel: string | null;
  /**
   * What the main button does. `open` opens the card's modal: the button
   * says so to assistive tech and the host receives an `open` action.
   */
  primaryAction: ConnectionCardPrimaryAction;
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
  /** Tools: the person's own connections they can let the bot use, at most {@link MAX_WAITING_ROWS}. */
  waiting: ConnectionCardRow[];
  /** Tools: "+N more in HQ Integrations", only when the person has more than the cap. */
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
  /**
   * The cards whose main button opens a modal. Leave it out to use
   * {@link CARD_MODAL_TARGETS}.
   */
  modalTargets?: ReadonlySet<ConnectTarget> | null;
}

/** The Slack card's line while its setup has been started and is not done. */
export const SLACK_UNFINISHED_LINE = "Setup is not finished.";
export const SLACK_TIMEOUT_NOTE = "Slack was not connected. You can try again any time.";
export const TOOLS_TIMEOUT_NOTE = "No new tool was connected. You can try again any time.";

function timedOut(since: number, now: number): boolean {
  return now - since > CONNECTING_TIMEOUT_MS;
}

/** A "Not now" still stands unless this card is in a message written after it. */
function declineStands(since: number, messageAt: number | null | undefined): boolean {
  return !(typeof messageAt === "number" && Number.isFinite(messageAt) && messageAt > since);
}

function primaryActionOf(target: ConnectTarget, input: ConnectionCardInput): ConnectionCardPrimaryAction {
  return cardOpensModal(target, input.modalTargets) ? "open" : "connect";
}

function slackView(input: ConnectionCardInput): ConnectionCardView {
  const bot = input.botName.trim() || "your bot";
  const entry = input.record?.slack;
  const facts = input.slack ?? null;
  const hostNote = input.notes?.slack?.trim() || null;
  const primaryAction = primaryActionOf("slack", input);
  const base = {
    target: "slack" as const,
    title: "Slack",
    primaryAction,
    primaryPending: Boolean(input.inFlight?.has(connectionActionKey("slack", primaryAction))),
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
  // The server has Slack set up for this bot and it is not connected yet.
  // That is the truth whatever this device remembers, and it does not time
  // out: the card says what the setup is waiting for until the server says
  // otherwise.
  if (facts?.state === "pending") {
    return {
      ...base,
      state: "connecting",
      line: `${SLACK_UNFINISHED_LINE} ${slackPendingHint(facts.stage, bot)}`,
      primaryLabel: "Continue",
      declineLabel: "Not now",
      mark: null,
      note: hostNote,
    };
  }
  // The person started here and the server shows nothing yet (or could not be
  // asked). This wait does run out.
  if (entry?.state === "connecting" && !timedOut(entry.since, input.now)) {
    return {
      ...base,
      state: "connecting",
      line: SLACK_UNFINISHED_LINE,
      primaryLabel: "Continue",
      declineLabel: "Not now",
      mark: null,
      note: hostNote,
    };
  }
  return {
    ...base,
    state: "offered",
    line: `Talk to ${bot} in Slack and let it post there.`,
    primaryLabel: "Connect Slack",
    declineLabel: "Not now",
    mark: null,
    note: hostNote ?? (entry?.state === "connecting" ? SLACK_TIMEOUT_NOTE : null),
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
  const primaryAction = primaryActionOf("tools", input);
  const base = {
    target: "tools" as const,
    title: "Connect your tools",
    primaryAction,
    primaryPending: Boolean(input.inFlight?.has(connectionActionKey("tools", primaryAction))),
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
  target: ConnectionCardTarget;
  action: ConnectionCardAction;
  /** The connection of an "allow" press. */
  connectionId?: string;
  /** The app of an integration card's press. */
  domain?: string;
}

export type ConnectionCardActionHandler = (detail: ConnectionCardActionDetail) => void | Promise<void>;

/**
 * The cards of one message: a view per built-in card, a view per integration
 * item (or null for an app that draws no card), the link under the grid, and
 * where presses go.
 */
export interface ConnectionCards {
  views: Partial<Record<ConnectTarget, ConnectionCardView>>;
  /** The card of an app named by domain, or null when it draws none. Absent: no integration cards. */
  integration?: ((item: { domain: string; why?: string }) => ConnectionCardView | null) | null;
  /**
   * Whether a block's row may draw yet: null means draw it. A row with apps
   * in it waits while their lookups are unknown, so no card appears and then
   * goes away. Absent: draw at once.
   */
  rowReady?: ((items: ReadonlyArray<{ app?: ConnectTarget; domain?: string }>) => boolean) | null;
  /**
   * The quiet "Browse all in HQ Integrations" link under a row with an
   * integration card in it: the page it names, and how the host opens it.
   * Null or absent: no link.
   */
  browseAll?: { url: string; open: () => void } | null;
  onaction: ConnectionCardActionHandler;
}

/**
 * The cards of a whole conversation. The views are built per message, because
 * a card in a message written after a "Not now" is a new offer.
 */
export interface ConversationConnectionCards {
  cardsFor: (message: { eventId: string; createdAt?: string | null }) => ConnectionCards;
}

// ── Asking for the cards again ───────────────────────────────────────────
//
// The cards sit under the bot's first message, which scrolls away. So the
// row of suggested replies under the bot's newest message gets one more
// button from the app. Pressing it sends an ordinary message from the person,
// and the app draws the cards again under the bot's answer. Nothing is
// stored: which answers carry the cards is read from the conversation.

/** What the "Connect more" button sends, as the person's own visible message. */
export const CONNECT_MORE_REQUEST = "Connect more tools";

/** The button once Slack or a tool is connected (or while that is unknown). */
export const CONNECT_MORE_LABEL = "Connect more";

/** The button while nothing is connected yet: no Slack, no tool the bot can use. */
export const CONNECT_FIRST_LABEL = "Connect Slack or tools";

/**
 * The words on the app's extra button. "Nothing connected" has to be known
 * for both: when either answer is missing the button says "Connect more".
 */
export function connectMoreLabel(slack: SlackFacts | null | undefined, tools: ToolFacts | null | undefined): string {
  if (!slack || !tools) return CONNECT_MORE_LABEL;
  const anything = slack.state === "connected" || tools.usable.length > 0;
  return anything ? CONNECT_MORE_LABEL : CONNECT_FIRST_LABEL;
}

/**
 * Whether a message is the request for the cards: exactly the phrase, in any
 * letter case, with spaces around it or one full stop after it. A longer
 * sentence that only contains the phrase is not the request.
 */
export function isConnectMoreRequest(text: string | null | undefined): boolean {
  const said = (text ?? "").trim().replace(/\s*\.$/, "").trim().toLowerCase();
  return said === CONNECT_MORE_REQUEST.toLowerCase();
}

interface ConversationMessageLike {
  eventId: string;
  fromPersonUid?: string | null;
  body?: string | null;
  richContent?: unknown;
}

/**
 * The bot's newest message, if the newest thing to read in the conversation
 * is the bot's: the message the suggested replies sit under. Null once the
 * person has written after it. `messages` is the timeline, oldest first.
 */
export function newestBotMessage<M extends ConversationMessageLike>(
  messages: ReadonlyArray<M>,
  botUid: string,
  hasVisibleContent: (message: M) => boolean,
): M | null {
  const uid = botUid.trim();
  if (!uid) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if ((message.fromPersonUid ?? "").trim() !== uid) return null;
    if (hasVisibleContent(message)) return message;
  }
  return null;
}

/**
 * The bot's answers that get the cards attached: for each request from the
 * person, the bot's first message with something to read after it, unless
 * that message already carries a `connect` block of its own. Returns event
 * ids, oldest first, each once. `messages` is the timeline, oldest first.
 */
export function connectMoreAnswerIds<M extends ConversationMessageLike>(
  messages: ReadonlyArray<M>,
  botUid: string,
  is: { visible: (message: M) => boolean; ownCards: (message: M) => boolean },
): string[] {
  const uid = botUid.trim();
  if (!uid) return [];
  const out: string[] = [];
  let asked = false;
  for (const message of messages) {
    const fromBot = (message.fromPersonUid ?? "").trim() === uid;
    if (!fromBot) {
      if (isConnectMoreRequest(message.body)) asked = true;
      continue;
    }
    if (!asked || !is.visible(message)) continue;
    asked = false;
    if (!is.ownCards(message) && message.eventId && !out.includes(message.eventId)) out.push(message.eventId);
  }
  return out;
}
