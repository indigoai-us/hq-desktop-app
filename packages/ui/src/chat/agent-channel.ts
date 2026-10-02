/**
 * Agent-channel helpers (US-011).
 *
 * An agent channel is a company-scoped chat that includes an `agt_*` member.
 * While its status lifecycle card is pending, the composer stays locked.
 */

import type { ConversationMessageWire } from "./chat-api.js";
import { CONNECT_MORE_REQUEST } from "./messaging/connection-card-model.js";
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
const CONNECT_EXAMPLE = fencedBlockExample({ kind: "connect", targets: ["slack"] });

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
 * The app draws two connection cards (Slack, Connect your tools) under that
 * first message, so the bot is told to point at them, to offer two first jobs
 * that need nothing connected, how to show the cards again later, and that
 * the app shows them by itself when the person asks to connect more.
 */
export function buildAgentHelloRequest(input: {
  personName?: string | null;
  filesStillDownloading: boolean;
}): string {
  const person = personOrFallback(input.personName);
  const files = input.filesStillDownloading
    ? " Your company files are still downloading in the background, so say that you can chat now and will know more about the company as that finishes."
    : "";
  return (
    `${AGENT_HELLO_REQUEST_OPENING} and ${person} is about to open this conversation. ` +
    `${person} cannot see this message. Write your first message to ${person} now: say hello in one or two short sentences ` +
    `and ask what you can help with first.${files} ` +
    `Then say in one short sentence that ${person} can connect Slack or their tools with the cards under this message, or skip that for now. ` +
    `The app shows those cards under your message by itself. ` +
    `End your message with a suggestions block of exactly two first jobs that need only the company files in HQ, ` +
    `each written as ${person}'s request and under 80 characters, exactly in this form:\n` +
    `${SUGGESTIONS_EXAMPLE}\n` +
    `Later, when a task needs Slack or a tool that is not connected, you can show the cards again by ending a message with:\n` +
    `${CONNECT_EXAMPLE}\n` +
    `The targets can be "slack", "tools" or both. ` +
    `When ${person} writes "${CONNECT_MORE_REQUEST}", answer in one short sentence: the app shows the connection cards under your answer by itself. ` +
    `Never ask for a password or a token in chat. ` +
    `Do not mention this message or that you were asked to write.`
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
 */
export function buildAgentSlackConnectedNotice(input: { personName?: string | null }): string {
  const person = personOrFallback(input.personName);
  return (
    `${AGENT_HELLO_REQUEST_LEAD} ${person} just connected you to Slack. ` +
    `${person} cannot see this message. Write ${person} a short message: say you are in Slack now and offer two or three things ` +
    `you can do there (for example post a daily summary to a channel, answer questions in a channel, send ${person} a reminder). ` +
    `Put them in a suggestions block at the very end of your message, exactly in this form, ` +
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
  const chatReady = !failed && (fullyReady || stepsReady);
  const runtime = isRecord(agent?.runtime) ? agent.runtime : null;
  const filesDone = runtime ? typeof runtime.syncOkAt === "string" && runtime.syncOkAt.length > 0 : fullyReady;
  return { chatReady, catchingUp: chatReady && !filesDone, failed };
}

export function agentCatchingUpLine(agentName: string): string {
  return `${agentName} is still downloading your company's files. You can chat now, and it will know more as it catches up.`;
}

export function agentComposerPlaceholder(agentName: string): string {
  return `${agentName} is still setting up`;
}
