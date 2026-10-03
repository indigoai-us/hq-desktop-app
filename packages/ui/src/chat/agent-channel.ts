/**
 * Agent-channel helpers (US-011).
 *
 * An agent channel is a company-scoped chat that includes an `agt_*` member.
 * While its status lifecycle card is pending, the composer stays locked.
 */

import type { ConversationMessageWire } from "./chat-api.js";
import { CONNECT_MORE_REQUEST } from "./messaging/connection-card-model.js";
import {
  connectItemLabel,
  normalizeConnectDomain,
  richContentForMessage,
  type ConnectItem,
} from "./messaging/richMessageContent.js";
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
const CONNECT_EXAMPLE = fencedBlockExample({
  kind: "connect",
  items: [{ app: "slack" }, { domain: "linear.app", why: "Your team's issues live here" }],
});

/** The whole hello request stays under this many characters. */
export const AGENT_HELLO_REQUEST_MAX_CHARS = 4_000;
/** The apps section of a request stays under this many characters (see `companyAppsBrief`). */
export const AGENT_REQUEST_APPS_MAX_CHARS = 1_400;

/**
 * How the bot is told to choose the apps for the cards. Shared by the hello
 * request and the request behind "Connect more tools".
 *
 * `companyApps` is the apps brief the app wrote from the company's
 * connection list (integration-cards-model.ts, `companyAppsBrief`): null
 * when the list could not be read (no section), "" when nothing is
 * connected, else one line per app.
 */
function appPickingInstructions(person: string, companyApps: string | null | undefined): string {
  const apps = companyApps == null ? null : companyApps.replace(/```/g, "'''").slice(0, AGENT_REQUEST_APPS_MAX_CHARS).trim();
  const section =
    apps === null ? "" : apps === "" ? "The company has no connected apps yet.\n" : `The company's connected apps:\n${apps}\n`;
  return (
    `The app draws one card under your message for each app you name in a connect block, with the app's logo, ` +
    `so ${person} can connect it or let you use it. Pick at most three apps, in this order: Slack, unless the list says Slack is connected; ` +
    `then the company's connected apps that you cannot use yet and that matter most for your work; ` +
    `then the apps this company would get the most from, judged from the company's files and work. ` +
    `In the connect block, name each app by its website domain (for example linear.app or notion.so) and give a reason under 60 characters as its why.\n` +
    section
  );
}

/**
 * The rule that keeps the apps out of the prose. Shared by the hello request
 * and the request behind "Connect more tools". Live walkthrough 2026-10-03:
 * the bot wrote "slack.com: See the conversations behind the work." and two
 * more lines like it, then "/help shows the available commands", with no
 * fence at all; the owner: "Why does it write the names of the apps in the
 * message? That's not good." The cards carry the names and the reasons.
 */
const NO_NAMES_IN_TEXT =
  `Never write an app name, a website domain, a web address, a command, or "/help" in your text, and do not mention commands at all: ` +
  `the apps you pick go only in the connect block, and the app draws them as cards with their logos and your reasons. `;

/** How the bot is told to write the fence: one fence, one envelope, one connect block, three items at most. */
const ONE_CONNECT_FENCE =
  `exactly one ${FENCE}hq-block fence holding one envelope with one connect block of at most three items, exactly in this form:\n` +
  `${CONNECT_EXAMPLE}\n`;

/** The sentence the hello ends with. The bot is told to write it word for word. */
export const AGENT_HELLO_PICK_LINE = "Pick a card below to connect something, or skip for now.";

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
 * The app draws one connection card under that first message for each app
 * the bot names in a connect block, so the bot is told what the company has
 * connected (`companyApps`) and how to pick at most three apps. The hello is
 * about connecting things and nothing else: two short sentences at most, a
 * greeting by name (with one clause about the files still downloading while
 * that is so) and the ask to pick a card. The apps live only in the envelope:
 * no app name, domain, address or command in the text, and no suggestions
 * block: the cards are the choice (owner, live walkthrough 2026-10-03).
 */
export function buildAgentHelloRequest(input: {
  personName?: string | null;
  filesStillDownloading: boolean;
  /** The apps brief, "" when nothing is connected, null or absent when the list could not be read. */
  companyApps?: string | null;
}): string {
  const person = personOrFallback(input.personName);
  const files = input.filesStillDownloading
    ? ", say in one short clause that your company files are still downloading in the background,"
    : "";
  return (
    `${AGENT_HELLO_REQUEST_OPENING} and ${person} is about to open this conversation. ` +
    `${person} cannot see this message. Write your first message to ${person} now, two short sentences at most: ` +
    `greet ${person} by name${files} and end with "${AGENT_HELLO_PICK_LINE}" ` +
    NO_NAMES_IN_TEXT +
    `Do not ask what you can help with, do not list what you can do, and do not add a suggestions block: the cards are the choice. ` +
    appPickingInstructions(person, input.companyApps) +
    `End your message with ${ONE_CONNECT_FENCE}` +
    `Later, when a task needs an app that is not connected, you can show cards again by ending a message with a connect block. ` +
    `When ${person} writes "${CONNECT_MORE_REQUEST}", answer in one short sentence and end with a connect block chosen the same way. ` +
    `Never ask for a password or a token in chat. ` +
    `Do not mention this message or that you were asked to write.`
  );
}

/**
 * The request the app sends a cloud bot, on the bot-only lane, when the
 * person asks to connect more apps (the "Connect more tools" message, from
 * the chip or typed). It carries the apps brief and the same picking
 * instructions as the hello, and asks for one short sentence and one fence
 * with one connect block of at most three items. The bot's visible answer to
 * the person then carries the block.
 */
export function buildAgentConnectMoreRequest(input: { personName?: string | null; companyApps?: string | null }): string {
  const person = personOrFallback(input.personName);
  return (
    `${AGENT_HELLO_REQUEST_LEAD} ${person} just asked to connect more apps (their message "${CONNECT_MORE_REQUEST}"). ` +
    `${person} cannot see this message. Answer ${person} in one short sentence and end your message with ${ONE_CONNECT_FENCE}` +
    NO_NAMES_IN_TEXT +
    appPickingInstructions(person, input.companyApps) +
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
  const stepsReady =
    steps !== null &&
    CHAT_READY_STEPS.every((name) =>
      steps.some((step) => lowerText(step.name) === name && lowerText(step.status) === "done"),
    );
  // The server says when the bot can chat (`setupState.chatReady`). Under the
  // chat-first setup order the runtime that answers is installed after the
  // sign-in and sync steps, so the step list alone would say ready too early.
  // The step rule stays for payloads without the flag (older deployments).
  const serverChatReady = typeof setup?.chatReady === "boolean" ? setup.chatReady : null;
  const chatReady = !failed && (fullyReady || (serverChatReady ?? stepsReady));
  const runtime = isRecord(agent?.runtime) ? agent.runtime : null;
  const filesDone = runtime ? typeof runtime.syncOkAt === "string" && runtime.syncOkAt.length > 0 : fullyReady;
  return { chatReady, catchingUp: chatReady && !filesDone, failed };
}

// ── The hello's text and cards, as the app shows them ────────────────────
//
// The request above tells the bot what to write. The bot does not always
// follow it: on 2026-10-03 "Big Nuts" wrote three "domain: reason" lines and
// a "/help" sentence, and no fence at all. The app cleans that text before
// it is drawn, and decides whose picks the cards show: the bot's when its
// envelope parsed, the app's otherwise.

/** A line's leading list marker: "- ", "* ", "• ", "1. ", "1) ". */
const LIST_MARKER_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
/** "<prefix>: <text>", the prefix on one line and short. */
const PREFIXED_LINE_RE = /^([^:\n]{1,80}?)\s*:\s+\S/;
/** A sentence that points at a command list. */
const COMMAND_SENTENCE_RE = /\/help|available commands/i;
/** Where one sentence ends and the next begins. */
const SENTENCE_BREAK_RE = /(?<=[.!?])\s+/;

/** The names a connect item may be written under in prose, lower-cased. */
function connectItemNames(item: ConnectItem): string[] {
  const names = [connectItemLabel(item).toLowerCase()];
  if (item.app === "slack") names.push("slack.com");
  if (item.domain) names.push(item.domain, item.domain.split(".")[0] ?? "");
  return names.filter(Boolean);
}

/**
 * The bot's hello, or its answer to "Connect more tools", as a person should
 * read it. Pure. Takes out:
 *
 * - a line written as `<domain>: <text>`, whatever the domain, and a line
 *   written as `<App name>: <text>` when the name is one of `items` (the
 *   cards under the message, the bot's own or the app's). A list marker in
 *   front of the line, or bold around the name, does not save it;
 * - a sentence that mentions `/help` or "available commands".
 *
 * Any other text is left as it is, so this is only ever applied to those
 * two messages, never to ordinary ones.
 */
export function cleanAgentHelloText(text: string, items: ReadonlyArray<ConnectItem> = []): string {
  if (!text) return text;
  const names = new Set(items.flatMap(connectItemNames));
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const bare = line.replace(LIST_MARKER_RE, "");
    const prefixed = PREFIXED_LINE_RE.exec(bare);
    if (prefixed) {
      const prefix = prefixed[1]!.replace(/[*_`"']/g, "").trim().toLowerCase();
      // A domain ends in a top-level label of two letters or more, so "e.g" is not one.
      const isDomain = normalizeConnectDomain(prefix) !== null && /\.[a-z]{2,}$/.test(prefix);
      if (isDomain || names.has(prefix)) continue;
    }
    if (!COMMAND_SENTENCE_RE.test(line)) {
      kept.push(line);
      continue;
    }
    const sentences = line.split(SENTENCE_BREAK_RE).filter((sentence) => !COMMAND_SENTENCE_RE.test(sentence));
    const rest = sentences.join(" ").trim();
    if (rest) kept.push(line.replace(line.trim(), rest));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
