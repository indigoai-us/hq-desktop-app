/**
 * Integration cards in a cloud bot's direct message: the pure model.
 *
 * A bot names apps by their website domain (a `connect` block's items, see
 * richMessageContent.ts). This file turns each item plus what the app knows
 * into one card view, or no card. No Svelte, no requests: everything here is
 * a function of its arguments, so it is testable on its own.
 *
 * WHAT THE BOT SUPPLIES: a domain and an optional sanitized reason. Nothing
 * else. The reason is shown under the app's own sentence, with the bot's
 * name on it, and never in place of that sentence. The app supplies the name (the connection's, else the catalog's, else
 * the domain's first label), the logo (a bundled brand mark for the apps that
 * have one, else a generic glyph; never a remote image), every word, every
 * link and every state.
 *
 * WHAT DECIDES A CARD:
 * - a company connection whose listed domain is the item's (or the two are
 *   one another's subdomain): a connection card (connected, or "Let {bot} use
 *   it" for the person's own). A provider name alone never matches a domain;
 * - else a catalog match for the domain: a connectable card with its auth class;
 * - else no card. While the lookup is unknown there is no card yet, and the
 *   row waits for its lookups up to {@link ROW_SETTLE_MS}.
 *
 * The person's own presses (Connect, Not now) live in the per-bot record
 * (connection-card-model.ts, `apps`). "Connected" is never stored: it is
 * always read from the company's connection list.
 */

import { brandMarkFor } from "./app-brand-marks.js";
import type { ConnectItem, ConnectTarget } from "./richMessageContent.js";
import { normalizeConnectDomain } from "./richMessageContent.js";
import {
  CONNECTING_TIMEOUT_MS,
  connectionActionKey,
  type AppCardRecord,
  type BotConnectionRecord,
  type ConnectionCardLogo,
  type ConnectionCardPrimaryAction,
  type ConnectionCardView,
  type IntegrationAuthClass,
} from "./connection-card-model.js";

/** How long a row waits for unknown lookups before unknown items are left out (ms). */
export const ROW_SETTLE_MS = 2_000;

/** How many connections the apps brief for the bot lists. */
export const MAX_BRIEF_CONNECTIONS = 25;
/** The apps brief's cap, in characters. */
export const MAX_BRIEF_CHARS = 1_400;
/** How many cards the app chooses in all, Slack included. Owner: never four cards, three at most. */
export const MAX_FALLBACK_APPS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `factory:linear` → `linear`. */
export function providerSlug(provider: string): string {
  return provider.replace(/^factory:/i, "").trim().toLowerCase();
}

/** `linear.app` → `linear`. */
export function firstLabel(domain: string): string {
  return domain.split(".")[0] ?? "";
}

// ── The company's connections ────────────────────────────────────────────

export interface CompanyConnection {
  id: string;
  /** Provider without the `factory:` prefix, lower case, e.g. "linear". */
  provider: string;
  /** Display name, e.g. "Linear" or "Gmail (Stefan)". */
  name: string;
  /** The app's website domain, normalized, when the list carries it. */
  domain: string | null;
  createdBy: string;
  createdAt: string;
  /** `access.mode`: "everyone", "legacy-open", "private", "shared", or whatever else the server says. */
  mode: string;
}

/** The connections list envelope (`GET /v1/integrations/admin?companyUid=`), read for the cards. */
export interface CompanyConnections {
  viewerUid: string;
  /** Only owners and admins may add apps (and read the catalog). */
  canManage: boolean;
  /** Connected connections, as listed. */
  connections: CompanyConnection[];
  /** Rows in the recent audit per provider slug. */
  recentCallsByProvider: Record<string, number>;
  /** Rows in the recent audit per connection id, for rows that name one. */
  recentCallsByConnection: Record<string, number>;
}

function connectionName(raw: Record<string, unknown>, slug: string): string {
  const installed = isRecord(raw.installation) ? text(raw.installation.displayName) : "";
  if (installed) return installed;
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "App";
}

/**
 * Read the list. Null for anything that is not the envelope. Only connected
 * connections are kept: the card never claims an app that is revoked or
 * failing. Every field may be missing.
 */
export function readCompanyConnections(json: unknown): CompanyConnections | null {
  const root = isRecord(json) ? json : null;
  if (!root) return null;
  const viewer = isRecord(root.viewer) ? root.viewer : null;
  const connections: CompanyConnection[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(root.connections) ? root.connections : []) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id);
    if (!id || ids.has(id) || raw.status !== "connected") continue;
    ids.add(id);
    const provider = providerSlug(text(raw.provider));
    const installation = isRecord(raw.installation) ? raw.installation : null;
    connections.push({
      id,
      provider,
      name: connectionName(raw, provider),
      domain: normalizeConnectDomain(installation?.domain),
      createdBy: text(raw.createdBy),
      createdAt: text(raw.createdAt),
      mode: isRecord(raw.access) ? text(raw.access.mode) : "",
    });
  }
  const recentCallsByProvider: Record<string, number> = {};
  const recentCallsByConnection: Record<string, number> = {};
  for (const row of Array.isArray(root.audit) ? root.audit : []) {
    if (!isRecord(row)) continue;
    const provider = providerSlug(text(row.provider));
    if (provider) recentCallsByProvider[provider] = (recentCallsByProvider[provider] ?? 0) + 1;
    const connectionId = text(row.connectionId);
    if (connectionId) recentCallsByConnection[connectionId] = (recentCallsByConnection[connectionId] ?? 0) + 1;
  }
  return {
    viewerUid: text(viewer?.personUid),
    canManage: viewer?.canManageIntegrations === true,
    connections,
    recentCallsByProvider,
    recentCallsByConnection,
  };
}

/** Whether one domain is the other, or a subdomain of it. */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function newestFirst(connections: CompanyConnection[]): CompanyConnection[] {
  return [...connections].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * The connection a domain names: one whose listed domain equals it, else one
 * whose listed domain is its parent or its subdomain (`api.example.com` and
 * `example.com`). The newest wins when several match.
 *
 * A connection is never matched by its provider name. `factory:linear` does
 * not answer for `linear.app` unless the list says its domain is `linear.app`:
 * a provider name is one label, and a domain a bot wrote that only starts
 * with that label (`linear.example.org`) is some other site. A connection
 * the list gives no domain for is reached by its id alone (see
 * {@link connectionForItem}), which only the app's own picks carry.
 */
export function connectionForDomain(facts: CompanyConnections | null | undefined, domain: string): CompanyConnection | null {
  if (!facts) return null;
  const wanted = normalizeConnectDomain(domain);
  if (!wanted) return null;
  const listed = facts.connections.filter((c) => c.domain !== null);
  const exact = listed.filter((c) => c.domain === wanted);
  const matches = exact.length > 0 ? exact : listed.filter((c) => sameSite(c.domain!, wanted));
  return newestFirst(matches)[0] ?? null;
}

/**
 * The connection a card's item names: the one with the item's own id when the
 * app put one on it and the list still has it, else the one its domain names.
 */
export function connectionForItem(
  facts: CompanyConnections | null | undefined,
  item: { domain?: string; connectionId?: string },
): CompanyConnection | null {
  if (!facts) return null;
  const id = item.connectionId?.trim();
  if (id) {
    const byId = facts.connections.find((c) => c.id === id);
    if (byId) return byId;
  }
  return item.domain ? connectionForDomain(facts, item.domain) : null;
}

/**
 * Whether a connection is the answer to a Connect press on this device, so
 * the bot may be given it with no second press. All three must hold:
 *
 * - the press is still waiting and is not stale: it was made at most
 *   {@link CONNECTING_TIMEOUT_MS} ago;
 * - the connection was made after the press, by the list's own `createdAt`;
 * - the list says the connection's domain is exactly the card's.
 *
 * Anything else (an old "connecting" entry left in storage, a connection
 * that was already there, a domain that only resembles the card's, a date
 * that cannot be read) is no answer: the card keeps its explicit
 * "Let {bot} use it" button and nothing is shared for the person.
 */
export function connectionAnswersPress(
  entry: AppCardRecord | null | undefined,
  connection: CompanyConnection | null | undefined,
  domain: string,
  now: number,
): boolean {
  if (!entry || entry.state !== "connecting" || !connection) return false;
  if (!Number.isFinite(entry.since) || now - entry.since > CONNECTING_TIMEOUT_MS) return false;
  const createdAt = Date.parse(connection.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= entry.since) return false;
  const wanted = normalizeConnectDomain(domain);
  return wanted !== null && connection.domain !== null && connection.domain === wanted;
}

/**
 * Whether the bot can use a connection: it is open to everyone, or the person
 * let the bot use it from here. A private or shared connection the record
 * does not know of is not usable, because the list does not say who it is
 * shared with.
 */
export function botCanUse(connection: CompanyConnection, record: BotConnectionRecord | null | undefined): boolean {
  if (connection.mode === "everyone" || connection.mode === "legacy-open") return true;
  return Boolean(record?.granted?.[connection.id]);
}

/** Recent calls for a connection: its own rows when the audit names it, else its provider's. */
export function recentCallsFor(facts: CompanyConnections, connection: CompanyConnection): number {
  return facts.recentCallsByConnection[connection.id] ?? facts.recentCallsByProvider[connection.provider] ?? 0;
}

// ── The catalog ──────────────────────────────────────────────────────────

/** A catalog entry whose domain is the item's. */
export interface CatalogMatch {
  domain: string;
  name: string;
  authClass: IntegrationAuthClass;
  entryId?: string;
}

/** What the app knows about a domain that is not connected: a match, none, or not asked yet. */
export type CatalogLookup = CatalogMatch | "not-found" | "unknown";

/**
 * Read a catalog answer (`GET /v1/integrations/factory/catalog`) for one
 * domain: the entry whose normalized domain equals it, or "not-found". An
 * entry with no auth class cannot be connected from a card, so it is no
 * match either.
 */
export function catalogMatchFor(json: unknown, domain: string): CatalogMatch | "not-found" {
  const wanted = normalizeConnectDomain(domain);
  const root = isRecord(json) ? json : null;
  if (!wanted || !root) return "not-found";
  for (const raw of Array.isArray(root.entries) ? root.entries : []) {
    if (!isRecord(raw)) continue;
    if (normalizeConnectDomain(raw.domain) !== wanted) continue;
    const authClass = raw.authClass;
    if (authClass !== "none" && authClass !== "oauth" && authClass !== "key") continue;
    const entryId = text(raw.entryId);
    return {
      domain: wanted,
      name: text(raw.name) || defaultAppName(wanted),
      authClass,
      ...(entryId ? { entryId } : {}),
    };
  }
  return "not-found";
}

/** The name the app falls back to: the domain's first label, upper-cased at the front. */
export function defaultAppName(domain: string): string {
  const label = firstLabel(domain);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "App";
}

// ── The logo ─────────────────────────────────────────────────────────────

/**
 * An app's logo: its bundled brand mark when it has one (app-brand-marks.ts),
 * else nothing, and the card draws the generic app glyph. Nothing is made up
 * from the name, and nothing is fetched: the app's image policy allows one
 * remote origin, the marketplace assets host (avatars/csp-image-src.ts), and
 * neither the catalog nor the connections list carries an icon on it. A
 * domain a bot names therefore never makes the webview call another host.
 */
export function appLogo(domain: string): ConnectionCardLogo {
  return { mark: brandMarkFor(normalizeConnectDomain(domain)) };
}

// ── The view ─────────────────────────────────────────────────────────────

export interface IntegrationCardInput {
  /** The bot's display name, written into the copy. */
  botName: string;
  record?: BotConnectionRecord | null;
  /** The company's connections, or null while unknown. */
  facts?: CompanyConnections | null;
  /** What the catalog says about this domain. */
  lookup: CatalogLookup;
  now: number;
  /** When the message carrying the card was written (ms). A card newer than a "Not now" is a new offer. */
  messageAt?: number | null;
  /** Action keys ({@link connectionActionKey}) on their way to the server. */
  inFlight?: ReadonlySet<string> | null;
  /** A sentence the host wants shown under this card: a failed connect or grant. */
  note?: string | null;
}

export const APP_TIMEOUT_NOTE = (name: string): string => `${name} was not connected. You can try again any time.`;

function declineStands(since: number, messageAt: number | null | undefined): boolean {
  return !(typeof messageAt === "number" && Number.isFinite(messageAt) && messageAt > since);
}

/** What the main button does for an app that is not connected: a key app opens the modal. */
export function connectActionFor(authClass: IntegrationAuthClass): ConnectionCardPrimaryAction {
  return authClass === "key" ? "open" : "connect";
}

/**
 * Build the card of one `connect` item that names a domain. Null when there
 * is no card: an unknown domain, or a lookup not settled yet. Pure.
 */
export function integrationCardView(
  item: { domain: string; why?: string; connectionId?: string },
  input: IntegrationCardInput,
): ConnectionCardView | null {
  const domain = normalizeConnectDomain(item.domain);
  if (!domain) return null;
  const bot = input.botName.trim() || "your bot";
  const connection = connectionForItem(input.facts, { domain, connectionId: item.connectionId });
  const match = typeof input.lookup === "object" ? input.lookup : null;
  if (!connection && !match) return null;
  const name = connection?.name || match?.name || defaultAppName(domain);
  const authClass = match?.authClass ?? null;
  const hostNote = input.note?.trim() || null;
  const entry = input.record?.apps?.[domain];
  const pending = (action: ConnectionCardPrimaryAction, connectionId?: string): boolean =>
    Boolean(input.inFlight?.has(connectionActionKey("integration", action, connectionId, domain)));
  const base = {
    target: "integration" as const,
    kind: "integration" as const,
    domain,
    logo: appLogo(domain),
    authClass,
    connectionId: connection?.id ?? null,
    title: name,
    usable: [] as string[],
    waiting: [],
    moreWaiting: null,
    declineLabel: null,
    mark: null,
    primaryPending: false,
  };

  if (connection) {
    const usable = botCanUse(connection, input.record);
    const own = input.facts?.viewerUid !== "" && connection.createdBy === input.facts?.viewerUid;
    if (usable) {
      return { ...base, state: "connected", line: `Connected. ${bot} can use it.`, primaryLabel: null, primaryAction: "allow", mark: "Connected", note: hostNote };
    }
    if (own) {
      return {
        ...base,
        state: "connected",
        line: `Connected. Let ${bot} use it?`,
        primaryLabel: `Let ${bot} use it`,
        primaryAction: "allow",
        primaryPending: pending("allow", connection.id),
        mark: "Connected",
        note: hostNote,
      };
    }
    return {
      ...base,
      state: "connected",
      line: `Connected by a teammate. Ask them to share it with ${bot}.`,
      primaryLabel: null,
      primaryAction: "allow",
      mark: "Connected",
      note: hostNote,
    };
  }

  // Not connected. The catalog match says how it connects.
  const action = connectActionFor(match!.authClass);
  const canConnect = input.facts ? input.facts.canManage : true;
  if (entry?.state === "declined" && declineStands(entry.since, input.messageAt)) {
    return { ...base, state: "declined", line: `Not connected. Ask ${bot} any time.`, primaryLabel: null, primaryAction: action, note: null };
  }
  const connecting = entry?.state === "connecting";
  const timedOut = connecting && input.now - entry.since > CONNECTING_TIMEOUT_MS;
  if (connecting && !timedOut) {
    return {
      ...base,
      state: "connecting",
      line: `Finish in your browser. This card updates when ${name} is connected.`,
      primaryLabel: "Open again",
      primaryAction: action,
      primaryPending: pending(action),
      declineLabel: "Not now",
      note: hostNote,
    };
  }
  if (!canConnect) {
    return { ...base, state: "offered", line: `Ask a company admin to connect ${name}.`, primaryLabel: null, primaryAction: action, note: hostNote };
  }
  // The app's own sentence always says what pressing the button does: the
  // bot gets to use the app. The bot's reason goes under it, with the bot's
  // name on it. A card with a note shows the note there instead: a card is
  // one fixed height, and a failure matters more than a reason.
  const note = hostNote ?? (timedOut ? APP_TIMEOUT_NOTE(name) : null);
  const why = item.why?.trim() ?? "";
  return {
    ...base,
    state: "offered",
    line: `Connect ${name} so ${bot} can use it.`,
    reason: why && !note ? botReason(bot, why) : null,
    primaryLabel: `Connect ${name}`,
    primaryAction: action,
    primaryPending: pending(action),
    declineLabel: "Not now",
    note,
  };
}

/** The bot's reason as the card shows it: the bot's name, then its words. */
export function botReason(botName: string, why: string): string {
  return `${botName.trim() || "your bot"} says: ${why.trim()}`;
}

/**
 * Whether an item's card is decided: it names a built-in card, or its domain
 * matches a connection, or its lookup has settled. The list itself being
 * unknown leaves a domain undecided.
 */
export function itemSettled(
  item: { app?: ConnectTarget; domain?: string; connectionId?: string },
  facts: CompanyConnections | null | undefined,
  lookupFor: (domain: string) => CatalogLookup,
): boolean {
  if (item.app) return true;
  const domain = normalizeConnectDomain(item.domain);
  if (!domain) return true;
  if (!facts) return false;
  if (connectionForItem(facts, { domain, connectionId: item.connectionId })) return true;
  return lookupFor(domain) !== "unknown";
}

/**
 * Whether a block's row may draw: every item is settled, or the row has
 * waited {@link ROW_SETTLE_MS} since `since`. After that, unknown items are
 * simply left out, and come in when they settle.
 */
export function connectRowReady(
  items: ReadonlyArray<{ app?: ConnectTarget; domain?: string; connectionId?: string }>,
  input: { facts: CompanyConnections | null | undefined; lookupFor: (domain: string) => CatalogLookup; since: number; now: number },
): boolean {
  if (input.now - input.since >= ROW_SETTLE_MS) return true;
  return items.every((item) => itemSettled(item, input.facts, input.lookupFor));
}

/** The domains of a block's items that need a catalog lookup: not a built-in, not a connection. */
export function domainsToLookUp(
  items: ReadonlyArray<{ app?: ConnectTarget; domain?: string; connectionId?: string }>,
  facts: CompanyConnections | null | undefined,
): string[] {
  if (!facts) return [];
  const out: string[] = [];
  for (const item of items) {
    const domain = item.app ? null : normalizeConnectDomain(item.domain);
    if (!domain || out.includes(domain) || connectionForItem(facts, { domain, connectionId: item.connectionId })) continue;
    out.push(domain);
  }
  return out;
}

// ── Errors ───────────────────────────────────────────────────────────────

export interface ConnectFailure {
  status?: number;
  code?: string;
  upstreamCode?: string;
}

/** The link's words under a sentence that sends the person to HQ Integrations. */
export const CONNECT_ELSEWHERE_LINK = "HQ Integrations";

/**
 * One sentence for a connect that did not work, from the server's answer.
 * `withLink` says the sentence ends by pointing at HQ Integrations, so the
 * card can draw that as a link.
 */
export function connectFailureSentence(failure: ConnectFailure | null | undefined, name: string): { sentence: string; withLink: boolean; retry: boolean } {
  const code = failure?.code ?? "";
  if (failure?.status === 402) return { sentence: "Your plan's integration limit is reached.", withLink: false, retry: false };
  if (failure?.status === 409 && code === "INTEGRATION_FACTORY_INSTALL_IN_PROGRESS") {
    return { sentence: `A connection for ${name} is already in progress. Give it a minute.`, withLink: false, retry: true };
  }
  if (code === "OAUTH_DISCOVERY_FAILED" || code === "CLIENT_REGISTRATION_REFUSED" || code.startsWith("OAUTH_REGISTRATION_")) {
    return { sentence: `${name} could not be connected from here. Try it from ${CONNECT_ELSEWHERE_LINK}.`, withLink: true, retry: false };
  }
  if (failure?.status === 403) return { sentence: "Only a company owner or admin can connect apps.", withLink: false, retry: false };
  return { sentence: "Could not start the connection. Try again.", withLink: false, retry: true };
}

/** One sentence for a key the server did not accept. The field is cleared; the person types again. */
export function keyRejectedSentence(failure: ConnectFailure | null | undefined, name: string): string {
  const code = failure?.code ?? "";
  if (failure?.status === 401 || /TOKEN|CREDENTIAL|UNAUTHORIZED|AUTH_FAILED/i.test(code)) {
    return `${name} did not accept that key. Check it and try again.`;
  }
  return connectFailureSentence(failure, name).sentence;
}

// ── The blueprint ────────────────────────────────────────────────────────

/** What a key app needs, read from a blueprint answer. */
export interface KeyBlueprint {
  /** The MCP URL the install names. Null when the blueprint has no MCP surface. */
  mcpUrl: string | null;
  provider: string | null;
  displayName: string | null;
  /** The credential's label, e.g. "API key". */
  label: string;
  /** Where to make one, when the blueprint says. */
  generateUrl: string | null;
}

function httpsUrl(value: unknown): string | null {
  const url = text(value);
  if (!/^https:\/\/[^\s"'<>]+$/i.test(url)) return null;
  return url;
}

/**
 * Read a blueprint answer (`POST /v1/integrations/factory/blueprint`) for a
 * key app. The MCP URL follows the server's own rule: the recommended
 * surface when it is an MCP surface, else the first MCP surface. The
 * credential is the one that surface names, else the first; its `label`
 * falls back to "Key". A `generateUrl` is kept only when it is an https URL.
 */
export function readKeyBlueprint(json: unknown): KeyBlueprint {
  const root = isRecord(json) ? json : null;
  const blueprint = isRecord(root?.blueprint) ? root.blueprint : null;
  const surfaces = (Array.isArray(blueprint?.surfaces) ? blueprint.surfaces : []).filter(isRecord);
  const recommended = isRecord(blueprint?.recommendedSurface) ? blueprint.recommendedSurface : null;
  const surface = recommended?.kind === "mcp" ? recommended : surfaces.find((s) => s.kind === "mcp") ?? null;
  const credentials = (Array.isArray(blueprint?.credentials) ? blueprint.credentials : []).filter(isRecord);
  const wantedIds = Array.isArray(surface?.credentialIds) ? surface.credentialIds.filter((id) => typeof id === "string") : [];
  const credential = credentials.find((c) => wantedIds.includes(text(c.id))) ?? credentials[0] ?? null;
  return {
    mcpUrl: httpsUrl(surface?.url),
    provider: text(blueprint?.provider) || null,
    displayName: text(blueprint?.displayName) || null,
    label: text(credential?.label) || "Key",
    generateUrl: httpsUrl(credential?.generateUrl),
  };
}

// ── What the app chooses when the bot does not ───────────────────────────

/**
 * The cards the app attaches when the bot's message carries no connect block:
 * Slack (unless the bot is in Slack), then the person's own connected apps
 * the bot cannot use yet, newest first, {@link MAX_FALLBACK_APPS} cards in
 * all (Slack counts as one).
 *
 * Each app's item carries the connection's id, so its card is that one
 * connection and no other. The item's domain is the one the list gives; a
 * connection the list gives no domain for is named `{provider}.com`, which
 * is only the card's name in the row (its logo, its key): the card finds the
 * connection by the id, never by that guess.
 */
export function appChosenItems(
  facts: CompanyConnections | null | undefined,
  record: BotConnectionRecord | null | undefined,
  slackConnected: boolean,
): ConnectItem[] {
  const items: ConnectItem[] = slackConnected ? [] : [{ app: "slack" }];
  if (!facts || !facts.viewerUid) return items;
  const own = newestFirst(facts.connections.filter((c) => c.createdBy === facts.viewerUid && !botCanUse(c, record)));
  const seen = new Set<string>();
  for (const connection of own) {
    if (items.length >= MAX_FALLBACK_APPS) break;
    const domain = connection.domain ?? normalizeConnectDomain(connection.provider ? `${connection.provider}.com` : null);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    items.push({ domain, connectionId: connection.id });
  }
  return items;
}

// ── The brief for the bot ────────────────────────────────────────────────

/**
 * A compact plain-text list of the company's connected apps for the bot, who
 * cannot read the list itself: name, domain, whether the bot can use it, and
 * its count in the recent calls. Up to {@link MAX_BRIEF_CONNECTIONS} apps,
 * most called first, then newest first; capped at {@link MAX_BRIEF_CHARS}
 * characters by dropping lines from the end. Empty when nothing is connected.
 *
 * "you can use it" is the same rule as the card's ({@link botCanUse}).
 */
export function companyAppsBrief(input: {
  facts: CompanyConnections | null | undefined;
  record?: BotConnectionRecord | null;
  /** The bot is in Slack: said first, so the bot does not offer Slack again. */
  slackConnected?: boolean;
}): string {
  const lines: string[] = [];
  if (input.slackConnected) lines.push("- Slack: connected, you can use it");
  const facts = input.facts;
  if (facts) {
    const ranked = [...facts.connections].sort((a, b) => {
      const calls = recentCallsFor(facts, b) - recentCallsFor(facts, a);
      if (calls !== 0) return calls;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    for (const connection of ranked.slice(0, MAX_BRIEF_CONNECTIONS)) {
      const name = briefText(connection.name) || defaultAppName(connection.domain ?? connection.provider);
      const where = connection.domain ? connection.domain : connection.provider ? `provider ${connection.provider}` : "";
      const usable = botCanUse(connection, input.record) ? "you can use it" : "not shared with you";
      const calls = recentCallsFor(facts, connection);
      const count = calls > 0 ? `, ${calls} recent call${calls === 1 ? "" : "s"}` : "";
      lines.push(`- ${name}${where ? ` (${where})` : ""}: connected, ${usable}${count}`);
    }
  }
  while (lines.length > 0 && lines.join("\n").length > MAX_BRIEF_CHARS) lines.pop();
  return lines.join("\n");
}

/** A name written into the brief: one line, no code marks, bounded. */
function briefText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}
