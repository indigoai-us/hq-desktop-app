/**
 * Pure helpers for the Cloud group of Settings → Bots.
 *
 * Cloud bots are company-hosted (`agt_*` entities provisioned through a company
 * channel). They are listed with the member-safe `GET /v1/agents/mobile-roster`
 * once per company, in parallel. The unscoped form (no companyUid) scans every
 * company in one sequential server request and runs past the 15s client
 * timeout for people in many companies (QA-080), so it is only a fallback when
 * no company uid is known. Rows carry setup phase but no runtime (paused/running) state
 * and no avatar; the pane renders an initial and infers "paused" only from its
 * own successful Pause action.
 */

import type { AdapterResult, Json } from "@hq/platform";
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

/**
 * Fetch the mobile roster for each company in parallel and merge the rows,
 * tagging each with its company when the server row omits it. Partial failure
 * still returns the companies that answered; `failure` is set only when every
 * request failed, so one slow company cannot blank the whole list.
 */
export async function fetchCloudRoster(
  listMobileRoster: (companyUid?: string | null) => Promise<AdapterResult<Json>>,
  companyUids: ReadonlyArray<string | null | undefined>,
): Promise<{ agents: unknown[]; failure: unknown | null }> {
  const uids = [...new Set(companyUids.map((uid) => (uid ?? "").trim()).filter(Boolean))];
  const scopes: Array<string | null> = uids.length ? uids : [null];
  const results = await Promise.all(
    scopes.map(async (uid) => {
      try {
        return { uid, result: await listMobileRoster(uid) };
      } catch (error) {
        return { uid, result: { ok: false as const, reason: "error" as const, message: error instanceof Error ? error.message : String(error) } };
      }
    }),
  );
  const agents: unknown[] = [];
  let failure: unknown | null = null;
  let anyOk = false;
  for (const { uid, result } of results) {
    if (!result.ok) {
      failure ??= result;
      continue;
    }
    anyOk = true;
    const value: unknown = result.value;
    const rec = isRecord(value) ? value : {};
    const list = Array.isArray(value) ? value : Array.isArray(rec.agents) ? rec.agents : [];
    const scope = uid ?? (str(rec.companyUid) || null);
    for (const item of list) {
      if (isRecord(item) && scope && !str(item.companyUid)) agents.push({ ...item, companyUid: scope });
      else agents.push(item);
    }
  }
  return { agents, failure: anyOk ? null : failure };
}
