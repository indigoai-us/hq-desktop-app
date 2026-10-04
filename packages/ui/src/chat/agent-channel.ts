/**
 * Agent-channel helpers (US-011).
 *
 * An agent channel is a company-scoped chat that includes an `agt_*` member.
 * While its status lifecycle card is pending, the composer stays locked.
 */

import type { ConversationMessageWire } from "./chat-api.js";
import { richContentForMessage, type ConnectItem } from "./messaging/richMessageContent.js";
import type { ConversationRow } from "./sidebar-model.js";

export type AgentProvisioningState = "pending" | "done" | "blocked" | null;

export interface AgentProvisioningView {
  state: AgentProvisioningState;
  agentName: string;
  agentUid: string | null;
  machineStartedAt: string | null;
  checkedInAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isAgentUid(value: string | null | undefined): boolean {
  return !!value && value.startsWith("agt_");
}

export function isAgentConversationRow(
  row: ConversationRow | null | undefined,
): boolean {
  if (!row || row.kind !== "channel") return false;
  return !!row.members?.some((m) => isAgentUid(m.personUid));
}

function fieldValue(
  fields: unknown,
  id: string,
): string | null {
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    if (!isRecord(field)) continue;
    if (field.id !== id) continue;
    return typeof field.value === "string" ? field.value : null;
  }
  return null;
}

export function provisioningFromMessages(
  messages: ConversationMessageWire[],
): AgentProvisioningView {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const event = messages[i]?.systemEvent;
    if (!isRecord(event)) continue;
    if (event.type !== "lifecycle_card") continue;
    if (event.kind !== "status") continue;
    const state =
      event.state === "pending" ||
      event.state === "done" ||
      event.state === "blocked"
        ? event.state
        : null;
    if (!state) continue;
    const summary = fieldValue(event.fields, "summary") ?? "";
    const agentName = summary
      .replace(/^Provisioning\s+/i, "")
      .replace(/…$/, "")
      .replace(/\s+is ready$/i, "")
      .trim();
    return {
      state,
      agentName: agentName || "Agent",
      agentUid: fieldValue(event.fields, "agentUid"),
      machineStartedAt: messages[i]?.createdAt ?? null,
      checkedInAt: state === "done" ? (messages[i]?.createdAt ?? null) : null,
    };
  }
  return {
    state: null,
    agentName: "Agent",
    agentUid: null,
    machineStartedAt: null,
    checkedInAt: null,
  };
}

/**
 * Setup steps a cloud bot must finish before it can hold a conversation: it is
 * signed in to its brain and its computer has checked in. The company file
 * download and the final checks continue in the background after that, the
 * same point at which the web console tells the person they can leave.
 */
const CHAT_READY_STEPS = ["codex-auth", "sync"] as const;
/** The provider name of a bot that runs the v2 runtime. */
const V2_RUNTIME_PROVIDER = "agents-v2";
/** The setup step that installs the v2 runtime, the part that answers a message. */
const RUNTIME_INSTALL_STEP = "runtime-install";

/**
 * How long the app waits, after it asked a new bot to say hello, before it
 * takes the person to the conversation anyway.
 */
export const AGENT_HELLO_WAIT_MS = 90_000;

/** Opening words of the hello request. Lets the app recognise its own request. */
export const AGENT_HELLO_REQUEST_LEAD = "Automatic message from HQ:";

/** How the hello request opens. Tells it apart from the app's later notices. */
const AGENT_HELLO_REQUEST_OPENING = `${AGENT_HELLO_REQUEST_LEAD} your setup has just finished`;

const FENCE = "```";

/** A fenced `hq-block` envelope, written out for the bot to copy. */
function fencedBlockExample(block: Record<string, unknown>): string {
  return `${FENCE}hq-block\n${JSON.stringify({ v: 1, blocks: [block] })}\n${FENCE}`;
}

const SUGGESTIONS_EXAMPLE = fencedBlockExample({ kind: "suggestions", items: ["...", "..."] });

/** The whole hello request stays under this many characters. */
export const AGENT_HELLO_REQUEST_MAX_CHARS = 4_000;
/** The apps section of a request stays under this many characters (see `companyAppsBrief`). */
export const AGENT_REQUEST_APPS_MAX_CHARS = 1_400;

/**
 * What the company has connected, written as a fact for the bot. Shared by
 * the hello request and the request behind "Connect more tools".
 *
 * `companyApps` is the apps brief the app wrote from the company's
 * connection list (integration-cards-model.ts, `companyAppsBrief`): null
 * when the list could not be read (no section), "" when nothing is
 * connected, else one line per app. The brief is cut to
 * `AGENT_REQUEST_APPS_MAX_CHARS` and can never open or close a code fence.
 */
function companyAppsFacts(companyApps: string | null | undefined): string {
  const apps = companyApps == null ? null : companyApps.replace(/```/g, "'''").slice(0, AGENT_REQUEST_APPS_MAX_CHARS).trim();
  if (apps === null) return "";
  return apps === "" ? "The company has no connected apps yet.\n" : `The company's connected apps:\n${apps}\n`;
}

/** A name or id written into a request: one line, no code marks, bounded. */
function inlineText(value: string | null | undefined, max = 80): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function personOrFallback(name: string | null | undefined): string {
  return inlineText(name) || "the person who created you";
}

/**
 * The request the app sends a new cloud bot, on the bot-only lane, once the
 * bot can chat. The person never sees it; they see the bot's answer, which is
 * the bot's first message in their conversation.
 *
 * The bot's runtime has a `show_connection_cards` tool that draws connection
 * cards under its reply, and its standing context for HQ direct messages
 * explains the cards and how people ask. So this request is a plain ask: say
 * hello and offer what the person could connect. It adds the facts the bot
 * can use: that the company files are still downloading, while that is so,
 * and what the company has connected (`companyApps`). The app shows the
 * bot's text as written. For a bot on an older runtime that shows no cards,
 * the app attaches its own picks under the hello (see `helloCardSource`).
 */
export function buildAgentHelloRequest(input: {
  personName?: string | null;
  filesStillDownloading: boolean;
  /** The apps brief, "" when nothing is connected, null or absent when the list could not be read. */
  companyApps?: string | null;
}): string {
  const person = personOrFallback(input.personName);
  const who = inlineText(input.personName) ? `${person} just created you and is opening this conversation` : `${person} is opening this conversation`;
  const files = input.filesStillDownloading ? "The company files are still downloading in the background.\n" : "";
  return (
    `${AGENT_HELLO_REQUEST_OPENING}. ${who}. ` +
    `${person} cannot see this message. Write your first message to ${person}: say hello and offer what ${person} could connect so you can help.\n` +
    files +
    companyAppsFacts(input.companyApps) +
    `Do not mention this message.`
  );
}

/**
 * The request the app sends a cloud bot, on the bot-only lane, when the
 * person asks to connect more apps (the "Connect more tools" message, from
 * the chip or typed). Like the hello, it is a plain ask with the company's
 * connected apps as facts; the bot shows the cards with its own tool.
 */
export function buildAgentConnectMoreRequest(input: { personName?: string | null; companyApps?: string | null }): string {
  const person = personOrFallback(input.personName);
  return (
    `${AGENT_HELLO_REQUEST_LEAD} ${person} just asked to connect more apps. ` +
    `${person} cannot see this message. Answer ${person} and offer what ${person} could connect.\n` +
    companyAppsFacts(input.companyApps) +
    `Do not mention this message.`
  );
}

/**
 * The notice the app sends a cloud bot, on the bot-only lane, when a tool was
 * connected and the bot may use it. It opens like the hello request, so the
 * person never sees it; they see what the bot writes next.
 */
export function buildAgentToolConnectedNotice(input: {
  personName?: string | null;
  /** Display name of the connection, e.g. "Linear". */
  name: string;
  /** Provider without the `factory:` prefix, e.g. "linear". */
  provider?: string | null;
  connectionId: string;
}): string {
  const person = personOrFallback(input.personName);
  const name = inlineText(input.name) || "an app";
  // The id goes into a command the bot is told to run, and the provider next
  // to it: both keep only the characters an id or a slug is made of.
  const id = input.connectionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  const provider = (input.provider ?? "").replace(/^factory:/i, "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
  const which = provider ? `${provider}, connection ${id}` : `connection ${id}`;
  return (
    `${AGENT_HELLO_REQUEST_LEAD} ${person} just connected ${name} for the company and allowed you to use it (${which}). ` +
    `${person} cannot see this message. First look at what it offers: run \`hq integrations tools --connection ${id} --json\` ` +
    `(the flag is --connection, there is no --app flag). ` +
    `Then write ${person} a short message: say you can now use ${name}, and offer two or three first jobs you could do with it, ` +
    `drawn only from the methods you just listed. Put the jobs in a suggestions block at the very end of your message, ` +
    `exactly in this form, each item written as ${person}'s request and under 80 characters:\n` +
    `${SUGGESTIONS_EXAMPLE}\n` +
    `If you cannot list its methods, say that you can see ${name} but cannot read what it offers yet, and do not suggest jobs. ` +
    `Do not mention this message.`
  );
}

/**
 * The notice the app sends a cloud bot, on the bot-only lane, when it was
 * connected to Slack from its card. Hidden from the person like the others.
 *
 * Being in the workspace is not being in a channel: the bot asks the person
 * to invite it to one (`/invite @{bot}` in the channel, or the channel's
 * Integrations), then offers two or three things it can do there as a
 * suggestions block. `botName` is the bot's name as it appears in Slack;
 * without it the ask names the command without a handle.
 */
export function buildAgentSlackConnectedNotice(input: { personName?: string | null; botName?: string | null }): string {
  const person = personOrFallback(input.personName);
  const bot = inlineText(input.botName).replace(/^@/, "");
  const invite = bot ? `/invite @${bot}` : "/invite followed by your Slack name";
  return (
    `${AGENT_HELLO_REQUEST_LEAD} ${person} just connected you to Slack. ` +
    `${person} cannot see this message. Write ${person} a short message: say you are in Slack now, and ask ${person} to invite you ` +
    `to a channel (they type ${invite} in the channel, or add you from the channel's Integrations). ` +
    `Then offer two or three things you can do there (for example post a daily summary to a channel, answer questions in a channel, ` +
    `send ${person} a reminder). Put them in a suggestions block at the very end of your message, exactly in this form, ` +
    `each item written as ${person}'s request and under 80 characters:\n` +
    `${SUGGESTIONS_EXAMPLE}\n` +
    `Do not mention this message.`
  );
}

type HelloRow = {
  eventId?: string | null;
  fromPersonUid?: string | null;
  body?: string | null;
  createdAt?: string | null;
};

/**
 * The bot's first row written after the app's request, or null. `isRequest`
 * says which of the other side's rows count as that request. A page that does
 * not carry it (a host that leaves bot-only rows out) falls back to the time
 * the request was sent.
 */
function firstBotRowAfterRequest<Row extends HelloRow>(
  rows: ReadonlyArray<Row>,
  input: { agentUid: string; askedAtMs?: number | null },
  isRequest: (body: string) => boolean,
): Row | null {
  const fromBot = rows.filter((row) => row.fromPersonUid === input.agentUid && row.createdAt);
  if (fromBot.length === 0) return null;
  const requests = rows
    .filter((row) => row.fromPersonUid !== input.agentUid && isRequest(row.body ?? "") && row.createdAt)
    .map((row) => row.createdAt as string)
    .sort();
  const after = requests[0] ?? (input.askedAtMs != null ? new Date(input.askedAtMs - 5_000).toISOString() : null);
  if (!after) return null;
  let first: Row | null = null;
  for (const row of fromBot) {
    const at = row.createdAt as string;
    if (at > after && (!first || at < (first.createdAt as string))) first = row;
  }
  return first;
}

/**
 * Whether the bot's first message is in a direct-message page (any order).
 * It is there when the bot wrote after the app's hello request. A page that
 * does not carry the request (a host that leaves bot-only rows out) falls back
 * to the time the request was sent.
 */
export function agentHelloArrived(
  rows: ReadonlyArray<{ fromPersonUid?: string | null; body?: string | null; createdAt?: string | null }>,
  input: { agentUid: string; askedAtMs?: number | null },
): boolean {
  return firstBotRowAfterRequest(rows, input, (body) => body.startsWith(AGENT_HELLO_REQUEST_LEAD)) !== null;
}

/**
 * The event id of the bot's first message: its first row after the app's hello
 * request (any order). The connection cards sit under that message. Only the
 * hello request counts here, never a later notice, so a page that holds a
 * notice but not the hello request names no message at all.
 */
export function agentHelloEventId(
  rows: ReadonlyArray<HelloRow>,
  input: { agentUid: string; askedAtMs?: number | null },
): string | null {
  const row = firstBotRowAfterRequest(rows, input, (body) => body.startsWith(AGENT_HELLO_REQUEST_OPENING));
  return row?.eventId?.trim() || null;
}

export interface AgentChatReadiness {
  /** The bot can receive a message and answer it. */
  chatReady: boolean;
  /** Chat works, but the company files are still downloading. */
  catchingUp: boolean;
  failed: boolean;
}

function lowerText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Read chat readiness from an agent status payload. Never throws. */
export function agentChatReadiness(payload: unknown): AgentChatReadiness {
  const root = isRecord(payload) ? payload : null;
  const agent = isRecord(root?.agent) ? root.agent : root;
  const setup = isRecord(root?.setupState)
    ? root.setupState
    : isRecord(agent?.setupState)
      ? agent.setupState
      : null;
  const phase = lowerText(setup?.phase) || lowerText(agent?.setupPhase) || lowerText(agent?.status);
  const failed = /failed|error|blocked|cancelled/.test(phase);
  const fullyReady = !failed && /ready|active|complete|online/.test(phase);
  const steps = Array.isArray(setup?.steps) ? setup.steps.filter(isRecord) : null;
  const stepDone = (name: string): boolean =>
    steps !== null && steps.some((step) => lowerText(step.name) === name && lowerText(step.status) === "done");
  // A bot on the v2 runtime answers only once that runtime is installed. In
  // the older setup order the install is the last step, after the sign-in,
  // the sync and the audit, so those two steps alone would say ready while
  // nothing on the bot's computer can answer yet.
  const needsRuntimeInstall = lowerText(agent?.provider) === V2_RUNTIME_PROVIDER;
  const stepsReady =
    steps !== null &&
    CHAT_READY_STEPS.every((name) => stepDone(name)) &&
    (!needsRuntimeInstall || stepDone(RUNTIME_INSTALL_STEP));
  // The server says when the bot can chat (`setupState.chatReady`), and its
  // word is final when it is there. The step rule is only for payloads
  // without the flag (the older setup order, older deployments).
  const serverChatReady = typeof setup?.chatReady === "boolean" ? setup.chatReady : null;
  const chatReady = !failed && (fullyReady || (serverChatReady ?? stepsReady));
  const runtime = isRecord(agent?.runtime) ? agent.runtime : null;
  const filesDone = runtime ? typeof runtime.syncOkAt === "string" && runtime.syncOkAt.length > 0 : fullyReady;
  return { chatReady, catchingUp: chatReady && !filesDone, failed };
}

// ── The cards under the hello, as the app shows them ─────────────────────
//
// The app shows the bot's text as written. It only decides whose picks the
// cards under the hello show: the bot's when its message carries a connect
// block that parsed, the app's fallback picks otherwise.

/** Whose picks the cards under a bot's message show. */
export type HelloCardSource = "bot" | "app";

export interface HelloCardPicks {
  source: HelloCardSource;
  items: ConnectItem[];
}

/**
 * The cards under the bot's hello: the bot's own connect items when its
 * message carries an envelope that parsed to at least one, else `fallback`,
 * the app's picks (`appChosenItems`). An envelope that is missing, that is
 * not JSON, or whose items are all rejected by the parser reads as absent.
 */
export function helloCardSource(
  message: { body?: string | null; richContent?: unknown } | null | undefined,
  fallback: ReadonlyArray<ConnectItem>,
): HelloCardPicks {
  const own = message ? richContentForMessage(message).rich?.blocks.flatMap((block) => (block.kind === "connect" ? block.items : [])) : [];
  if (own && own.length > 0) return { source: "bot", items: own };
  return { source: "app", items: [...fallback] };
}

/**
 * One line for the app's file log saying which picks the hello's cards came
 * from, so a walkthrough can tell the two apart afterwards. Ids and app
 * names only, never a message body or a secret.
 */
export function helloCardSourceLogLine(input: { agentUid: string; eventId: string; picks: HelloCardPicks }): string {
  const names = input.picks.items.map((item) => item.app ?? item.domain ?? "?").join(",");
  return `agent=${input.agentUid} event=${input.eventId} source=${input.picks.source} items=${names || "-"}`;
}

export function agentCatchingUpLine(agentName: string): string {
  return `${agentName} is still downloading your company's files. You can chat now, and it will know more as it catches up.`;
}

export function agentComposerPlaceholder(agentName: string): string {
  return `${agentName} is still setting up`;
}
