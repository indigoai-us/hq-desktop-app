/**
 * Where the team card's settled line comes from after the pick: it must
 * survive the switch to a newly created company's channel and an app
 * restart, so it is never only in memory.
 *
 * Two durable sources, either is enough:
 * - a record written when a pick succeeds, kept per account and setup bot in
 *   global (not company-scoped) storage, so a tenant switch does not hide it;
 * - the person's reply to the bot ("I created Acme."), which is in the
 *   conversation on the server.
 *
 * A create that made a company but whose reply has not gone through is kept
 * under the same key as `{ created, name }` until the reply is sent, so a
 * restart in between resends that reply instead of creating another company.
 */
import type { FirstRunTeamCompany } from "./team-step";

export const TEAM_CARD_RECORDS_KEY = "hq.firstRun.teamCard.v1";

/** Settled lines by `teamCardRecordKey`. */
export type TeamCardRecords = Readonly<Record<string, string>>;

/** A company a create made whose reply to the bot has not gone through, with the name the person typed. */
export interface TeamCardUnsentCreate {
  created: FirstRunTeamCompany;
  name: string;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

export function teamCardRecordKey(accountUid: string | null | undefined, agentUid: string): string {
  return `${(accountUid ?? "").trim()}:${agentUid.trim()}`;
}

function readTeamCardEntries(storage: ReadStorage | null | undefined): Record<string, unknown> {
  try {
    const raw = storage?.getItem(TEAM_CARD_RECORDS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn("[hq-desktop] could not read the saved team card picks:", err);
    return {};
  }
}

function writeTeamCardEntries(storage: WriteStorage | null | undefined, entries: Record<string, unknown>): void {
  try {
    storage?.setItem(TEAM_CARD_RECORDS_KEY, JSON.stringify(entries));
  } catch (err) {
    console.warn("[hq-desktop] could not save the team card pick:", err);
  }
}

function settledOnly(entries: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

export function loadTeamCardRecords(storage: ReadStorage | null | undefined): TeamCardRecords {
  return settledOnly(readTeamCardEntries(storage));
}

/**
 * Returns the records with this one added; a storage failure keeps it in
 * memory only. Replaces an unsent create under the same key.
 */
export function saveTeamCardRecord(
  storage: WriteStorage | null | undefined,
  records: TeamCardRecords,
  key: string,
  settled: string,
): TeamCardRecords {
  const next = { ...readTeamCardEntries(storage), ...records, [key]: settled };
  writeTeamCardEntries(storage, next);
  return settledOnly(next);
}

function unsentCreate(value: unknown): TeamCardUnsentCreate | null {
  if (!value || typeof value !== "object") return null;
  const { created, name } = value as { created?: unknown; name?: unknown };
  if (!created || typeof created !== "object" || typeof name !== "string" || !name.trim()) return null;
  const company = created as Partial<FirstRunTeamCompany>;
  if (typeof company.slug !== "string" || !company.slug.trim()) return null;
  if (typeof company.name !== "string" || !company.name.trim()) return null;
  const companyUid = typeof company.companyUid === "string" ? company.companyUid : null;
  return { created: { companyUid, slug: company.slug, name: company.name }, name };
}

/** The unsent create under `key`: a create made a company and its reply has not gone through. */
export function loadTeamCardUnsentCreate(
  storage: ReadStorage | null | undefined,
  key: string,
): TeamCardUnsentCreate | null {
  return unsentCreate(readTeamCardEntries(storage)[key]);
}

/**
 * Keep the company a create made, before its reply is sent. Never replaces a
 * settled line: the card under that key is already done.
 */
export function saveTeamCardUnsentCreate(
  storage: WriteStorage | null | undefined,
  key: string,
  unsent: TeamCardUnsentCreate,
): void {
  const entries = readTeamCardEntries(storage);
  if (typeof entries[key] === "string") return;
  writeTeamCardEntries(storage, { ...entries, [key]: { created: unsent.created, name: unsent.name } });
}

const REPLY_LINE = /^I (created|joined|opened) (.+)\.$/;
const SETTLED_VERB = { created: "Created", joined: "Joined", opened: "Opened" } as const;

/**
 * The settled line for a card reply (the inverse of `teamCardReplyText`), or
 * null for any other text.
 */
export function teamCardSettledFromReplyText(body: string | null | undefined): string | null {
  const text = (body ?? "").trim();
  if (text === "Just me for now.") return "Working solo";
  const match = REPLY_LINE.exec(text);
  if (!match) return null;
  const name = match[2].trim();
  return name ? `${SETTLED_VERB[match[1] as keyof typeof SETTLED_VERB]} ${name}` : null;
}

/**
 * The settled line from the conversation: the person's first message after
 * the bot's opening, when it is a card reply. Only the first counts, so
 * something typed later never settles the card.
 */
export function teamCardSettledFromReply(
  messages: ReadonlyArray<{ fromPersonUid?: string | null; body?: string | null }>,
  botUid: string,
): string | null {
  const uid = botUid.trim();
  if (!uid) return null;
  for (const message of messages) {
    if ((message.fromPersonUid ?? "").trim() === uid) continue;
    return teamCardSettledFromReplyText(message.body);
  }
  return null;
}
