/**
 * Agent-channel helpers (US-011).
 *
 * An agent channel is a company-scoped chat that includes an `agt_*` member.
 * While its status lifecycle card is pending, the composer stays locked.
 */

import type { ConversationMessageWire } from "./chat-api.js";
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

/** The status card every cloud bot's channel starts with. */
export const AGENT_STATUS_CARD_ID = "agent_status";
/**
 * Card action that asks the server to open the conversation for a bot that can
 * chat: the card turns done and the bot is prompted to say hello. A server
 * that predates it answers with an unknown-action refusal.
 */
export const AGENT_INTRO_ACTION_ID = "announce";

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
