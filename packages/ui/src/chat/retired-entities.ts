/**
 * Retired companies and the conversations that hang off them.
 *
 * `hq cloud retire company` soft-tombstones a company. hq-pro then leaves it
 * out of the company list (`/membership/me`), but the channel directory,
 * contacts and bot roster keep returning rows that point at it, with no
 * retired marker. A bot whose removal stopped half way can likewise keep a DM
 * row after its identity is gone.
 *
 * The desktop asks `GET /entity/{uid}` (Rust `resolve_retired_entities`) about
 * the company and bot uids it cannot place, and hides a row only on an
 * explicit "gone" answer. A company the list does not know yet (its channel
 * can arrive before the company list refreshes) reads as live and stays
 * visible, and a failed read hides nothing.
 */

import type { ConversationRow } from "./sidebar-model.js";

/** Wire shape of the Rust `resolve_retired_entities` command. */
export interface RetiredEntitiesResult {
  retiredCompanyUids?: string[];
  goneAgentUids?: string[];
  liveUids?: string[];
  agentCompanyUids?: Record<string, string[]>;
}

/** What the sidebar has learned so far, merged across probes. */
export interface RetiredEntities {
  retiredCompanyUids: ReadonlySet<string>;
  goneAgentUids: ReadonlySet<string>;
  /** Companies named by each live probed bot's config. */
  agentCompanyUids: ReadonlyMap<string, readonly string[]>;
}

export const NO_RETIRED_ENTITIES: RetiredEntities = Object.freeze({
  retiredCompanyUids: new Set<string>(),
  goneAgentUids: new Set<string>(),
  agentCompanyUids: new Map<string, readonly string[]>(),
});

const PROBE_UID = /^(cmp|agt)_[A-Za-z0-9_-]+$/;

function cleanUids(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const uid = value.trim();
    if (PROBE_UID.test(uid)) out.push(uid);
  }
  return out;
}

/**
 * Fold one probe answer into what is known. A uid the answer reports live is
 * removed from the retired/gone sets (a company can be restored).
 */
export function mergeRetiredEntities(
  prev: RetiredEntities,
  result: RetiredEntitiesResult | null | undefined,
): RetiredEntities {
  if (!result || typeof result !== "object") return prev;
  const retired = new Set(prev.retiredCompanyUids);
  const gone = new Set(prev.goneAgentUids);
  const agentCompanies = new Map(prev.agentCompanyUids);
  for (const uid of cleanUids(result.liveUids)) {
    retired.delete(uid);
    gone.delete(uid);
  }
  for (const uid of cleanUids(result.retiredCompanyUids)) {
    if (uid.startsWith("cmp_")) retired.add(uid);
  }
  for (const uid of cleanUids(result.goneAgentUids)) {
    if (uid.startsWith("agt_")) {
      gone.add(uid);
      agentCompanies.delete(uid);
    }
  }
  const map = result.agentCompanyUids;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [agentUid, companies] of Object.entries(map)) {
      if (!agentUid.startsWith("agt_")) continue;
      agentCompanies.set(
        agentUid,
        cleanUids(companies).filter((uid) => uid.startsWith("cmp_")),
      );
    }
  }
  return {
    retiredCompanyUids: retired,
    goneAgentUids: gone,
    agentCompanyUids: agentCompanies,
  };
}

/**
 * A company is retired only when the server said so AND it is not in the live
 * company list. The live list always wins, so a stale answer can never hide a
 * company the user can open.
 */
export function isRetiredCompany(
  companyUid: string | null | undefined,
  retired: RetiredEntities,
  liveCompanyUids: ReadonlySet<string>,
): boolean {
  const uid = (companyUid ?? "").trim();
  if (!uid || liveCompanyUids.has(uid)) return false;
  return retired.retiredCompanyUids.has(uid);
}

function isAgentUid(uid: string | null | undefined): uid is string {
  return typeof uid === "string" && uid.trim().startsWith("agt_");
}

/**
 * A bot is hidden when its identity is gone, or when every company it belongs
 * to is retired. A bot with no company (a personal bot), or one that is also
 * in a live company, stays.
 */
export function isRetiredBot(
  agentUid: string | null | undefined,
  retired: RetiredEntities,
  liveCompanyUids: ReadonlySet<string>,
): boolean {
  if (!isAgentUid(agentUid)) return false;
  const uid = agentUid.trim();
  if (retired.goneAgentUids.has(uid)) return true;
  const companies = retired.agentCompanyUids.get(uid);
  if (!companies || companies.length === 0) return false;
  return companies.every((company) => isRetiredCompany(company, retired, liveCompanyUids));
}

/** Whether a sidebar / palette row belongs to a retired company or bot. */
export function isRetiredConversationRow(
  row: Pick<ConversationRow, "kind" | "companyUid" | "personUid">,
  retired: RetiredEntities,
  liveCompanyUids: ReadonlySet<string>,
): boolean {
  if (row.kind === "dm") {
    // People outlive a company; only a bot DM can be retired with it.
    return isRetiredBot(row.personUid, retired, liveCompanyUids);
  }
  return isRetiredCompany(row.companyUid, retired, liveCompanyUids);
}

/** `rows` without the ones a retired company or bot left behind. */
export function withoutRetiredRows<T extends Pick<ConversationRow, "kind" | "companyUid" | "personUid">>(
  rows: readonly T[],
  retired: RetiredEntities,
  liveCompanyUids: ReadonlySet<string>,
): T[] {
  if (retired.retiredCompanyUids.size === 0 && retired.goneAgentUids.size === 0) {
    return rows as T[];
  }
  return rows.filter((row) => !isRetiredConversationRow(row, retired, liveCompanyUids));
}

/**
 * The uids worth asking the server about: companies that rows point at but the
 * live company list does not contain, and bot DM peers. Uids already asked
 * about are skipped, so each is read once per session unless it leaves the live
 * list later.
 */
export function retiredProbeCandidates(
  rows: ReadonlyArray<Pick<ConversationRow, "kind" | "companyUid" | "personUid">>,
  liveCompanyUids: ReadonlySet<string>,
  asked: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const company = (row.companyUid ?? "").trim();
    if (company && PROBE_UID.test(company) && company.startsWith("cmp_") && !liveCompanyUids.has(company)) {
      out.add(company);
    }
    if (row.kind === "dm" && isAgentUid(row.personUid)) {
      const agent = row.personUid.trim();
      if (PROBE_UID.test(agent)) out.add(agent);
    }
  }
  return [...out].filter((uid) => !asked.has(uid));
}

/** Live company uids from a workspace-like list. */
export function liveCompanyUidSet(
  companies: ReadonlyArray<{ kind?: string | null; cloudUid?: string | null }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const company of companies ?? []) {
    if (company?.kind && company.kind !== "company") continue;
    const uid = (company?.cloudUid ?? "").trim();
    if (uid) out.add(uid);
  }
  return out;
}
