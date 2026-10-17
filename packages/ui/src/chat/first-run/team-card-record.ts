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
 *
 * Before a create is sent, `{ creating: { name, slug } }` is kept under that
 * key. While it is there, the outcome of that create is unknown (it may time
 * out, fail, or be cut off by a restart after the server made the company), so
 * the card stays on that name and the next Create first looks for the company.
 * Its `failedLooks` counts the presses that looked and did not find it; once
 * that reaches the bound the card is unlocked and the entry is only a lookup
 * hint, so a later find still settles it.
 */
import type { FirstRunTeamCompany } from "./team-step";

export const TEAM_CARD_RECORDS_KEY = "hq.firstRun.teamCard.v1";

/** Settled lines by `teamCardRecordKey`. */
export type TeamCardRecords = Readonly<Record<string, string>>;

/** A company a create made whose reply to the bot has not gone through, with the name the person typed. */
export interface TeamCardUnsentCreate {
  created: FirstRunTeamCompany;
  name: string;
  /** How many sends of its reply have failed, so a restart does not reset the bound. */
  replyFailures?: number;
}

/** A create that was sent and has not answered: the name the person typed and its slug. */
export interface TeamCardCreating {
  name: string;
  slug: string;
  /** Presses that looked for the company and did not find it. */
  failedLooks?: number;
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

/** False when the write failed (or there is no storage): the caller keeps what it wrote in memory. */
function writeTeamCardEntries(storage: WriteStorage | null | undefined, entries: Record<string, unknown>): boolean {
  if (!storage) return false;
  try {
    storage.setItem(TEAM_CARD_RECORDS_KEY, JSON.stringify(entries));
    return true;
  } catch (err) {
    console.warn("[hq-desktop] could not save the team card pick:", err);
    return false;
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
  const { created, name, replyFailures } = value as { created?: unknown; name?: unknown; replyFailures?: unknown };
  if (!created || typeof created !== "object" || typeof name !== "string" || !name.trim()) return null;
  const company = created as Partial<FirstRunTeamCompany>;
  if (typeof company.slug !== "string" || !company.slug.trim()) return null;
  if (typeof company.name !== "string" || !company.name.trim()) return null;
  const companyUid = typeof company.companyUid === "string" ? company.companyUid : null;
  const failures = typeof replyFailures === "number" && Number.isInteger(replyFailures) && replyFailures > 0 ? replyFailures : 0;
  return { created: { companyUid, slug: company.slug, name: company.name }, name, ...(failures ? { replyFailures: failures } : {}) };
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
 * settled line: the card under that key is already done. Replaces a pending
 * create. False when it could not be saved.
 */
export function saveTeamCardUnsentCreate(
  storage: WriteStorage | null | undefined,
  key: string,
  unsent: TeamCardUnsentCreate,
): boolean {
  const entries = readTeamCardEntries(storage);
  if (typeof entries[key] === "string") return false;
  return writeTeamCardEntries(storage, { ...entries, [key]: { created: unsent.created, name: unsent.name } });
}

/** Count the failed sends of an unsent create's reply. Leaves anything else under `key`. */
export function saveTeamCardReplyFailures(storage: WriteStorage | null | undefined, key: string, replyFailures: number): boolean {
  const entries = readTeamCardEntries(storage);
  const unsent = unsentCreate(entries[key]);
  if (!unsent) return false;
  return writeTeamCardEntries(storage, { ...entries, [key]: { created: unsent.created, name: unsent.name, replyFailures } });
}

function pendingCreate(value: unknown): TeamCardCreating | null {
  if (!value || typeof value !== "object") return null;
  const { creating } = value as { creating?: unknown };
  if (!creating || typeof creating !== "object") return null;
  const { name, slug, failedLooks } = creating as { name?: unknown; slug?: unknown; failedLooks?: unknown };
  if (typeof name !== "string" || !name.trim() || typeof slug !== "string" || !slug.trim()) return null;
  const looks = typeof failedLooks === "number" && Number.isInteger(failedLooks) && failedLooks > 0 ? failedLooks : 0;
  return { name, slug, ...(looks ? { failedLooks: looks } : {}) };
}

/** The create under `key` that was sent and has not answered, if any. */
export function loadTeamCardCreating(storage: ReadStorage | null | undefined, key: string): TeamCardCreating | null {
  return pendingCreate(readTeamCardEntries(storage)[key]);
}

/**
 * Keep a create before it is sent. Never replaces a settled line or a company
 * a create already made. False when it could not be saved.
 */
export function saveTeamCardCreating(
  storage: WriteStorage | null | undefined,
  key: string,
  creating: TeamCardCreating,
): boolean {
  const entries = readTeamCardEntries(storage);
  if (typeof entries[key] === "string" || unsentCreate(entries[key])) return false;
  const { name, slug, failedLooks } = creating;
  return writeTeamCardEntries(storage, { ...entries, [key]: { creating: { name, slug, ...(failedLooks ? { failedLooks } : {}) } } });
}

/** Count the presses that looked for a pending create's company and did not find it. Leaves anything else under `key`. */
export function saveTeamCardFailedLooks(storage: WriteStorage | null | undefined, key: string, failedLooks: number): boolean {
  const entries = readTeamCardEntries(storage);
  const pending = pendingCreate(entries[key]);
  if (!pending) return false;
  return writeTeamCardEntries(storage, { ...entries, [key]: { creating: { name: pending.name, slug: pending.slug, failedLooks } } });
}

/** Forget a pending create: it is known to have made no company. Leaves anything else under `key`. */
export function clearTeamCardCreating(storage: WriteStorage | null | undefined, key: string): void {
  const entries = readTeamCardEntries(storage);
  if (!pendingCreate(entries[key])) return;
  const rest = { ...entries };
  delete rest[key];
  writeTeamCardEntries(storage, rest);
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
