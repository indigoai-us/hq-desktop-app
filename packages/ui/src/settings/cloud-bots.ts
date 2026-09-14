/**
 * Pure helpers for the Cloud group of Settings → Bots.
 *
 * Cloud bots are company-hosted (`agt_*` entities provisioned through a company
 * channel). The cheapest cross-company listing is the member-safe
 * `GET /v1/agents/mobile-roster` with no companyUid: hq-pro returns every
 * visible bot across all of the caller's active companies, each row tagged with
 * its companyUid. Rows carry setup phase but no runtime (paused/running) state
 * and no avatar; the pane renders an initial and infers "paused" only from its
 * own successful Pause action.
 */

import type { WorkspaceLike } from "../chat/channel-admin.js";
import { canEditAgentProfile } from "../avatars/can-edit.js";
import { deriveAgentWorkStatus, type AgentWorkStatus } from "../chat/agent-detail-model.js";

export interface CloudBotRow {
  uid: string;
  displayName: string;
  companyUid: string | null;
  companyLabel: string | null;
  status: AgentWorkStatus;
  /** Raw setup phase from the roster (`ready`, `provisioning`, `failed`, …). */
  phase: string;
  /** Owner/admin of the bot's company (or explicit admin) may pause/remove it. */
  canManage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Plain-language status for a cloud bot row. */
export function cloudBotStatusLabel(status: AgentWorkStatus, phase = ""): string {
  if (phase === "failed") return "Setup failed";
  if (phase === "deprovisioning" || phase === "deprovisioned") return "Removing";
  if (status === "WORKING") return "Working";
  if (status === "PROVISIONING") return "Setting up";
  return "Idle";
}

/** Single-letter monogram for a row without an avatar. */
export function cloudBotInitial(displayName: string): string {
  const first = displayName.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

/**
 * Normalize a mobile-roster payload into Cloud rows, sorted by name.
 * Archived/deprovisioned bots are dropped; duplicates (same uid across two
 * company scans) collapse to the first row.
 */
export function cloudBotsFromRoster(
  payload: unknown,
  input: {
    companies?: ReadonlyArray<WorkspaceLike & { displayName?: string }> | null;
    isAdmin?: boolean | null;
  } = {},
): CloudBotRow[] {
  const rec = isRecord(payload) ? payload : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec.agents)
      ? rec.agents
      : [];
  const names = new Map<string, string>();
  for (const w of input.companies ?? []) {
    const uid = (w.cloudUid ?? "").trim();
    if (uid) names.set(uid, w.displayName?.trim() || w.slug);
  }
  const seen = new Set<string>();
  const rows: CloudBotRow[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const uid = str(item.agentUid) || str(item.uid);
    if (!uid || seen.has(uid)) continue;
    const phase = (str(item.setupPhase) || str(item.status)).toLowerCase();
    if (phase === "deprovisioned" || phase === "archived") continue;
    seen.add(uid);
    const companyUid = str(item.companyUid) || null;
    rows.push({
      uid,
      displayName: str(item.displayName) || str(item.name) || uid,
      companyUid,
      companyLabel: companyUid ? (names.get(companyUid) ?? companyUid) : null,
      status: deriveAgentWorkStatus({
        setupPhase: phase,
        runtimeStatus: str(item.status),
      }),
      phase,
      canManage: canEditAgentProfile({
        agentUid: uid,
        agentCompanyUid: companyUid,
        companies: input.companies ?? null,
        isAdmin: input.isAdmin ?? null,
      }),
    });
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}
