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

export function agentNameFromRow(row: ConversationRow | null): string {
  const title = row?.title?.trim();
  if (title) return title;
  const member = row?.members?.find((m) => isAgentUid(m.personUid));
  return member?.displayName?.trim() || "Agent";
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

export function agentComposerPlaceholder(agentName: string): string {
  return `${agentName} is still setting up`;
}
