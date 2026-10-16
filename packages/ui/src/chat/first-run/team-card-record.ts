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
 */

export const TEAM_CARD_RECORDS_KEY = "hq.firstRun.teamCard.v1";

/** Settled lines by `teamCardRecordKey`. */
export type TeamCardRecords = Readonly<Record<string, string>>;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

export function teamCardRecordKey(accountUid: string | null | undefined, agentUid: string): string {
  return `${(accountUid ?? "").trim()}:${agentUid.trim()}`;
}

export function loadTeamCardRecords(storage: ReadStorage | null | undefined): TeamCardRecords {
  try {
    const raw = storage?.getItem(TEAM_CARD_RECORDS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) out[key] = value;
    }
    return out;
  } catch (err) {
    console.warn("[hq-desktop] could not read the saved team card picks:", err);
    return {};
  }
}

/** Returns the records with this one added; a storage failure keeps it in memory only. */
export function saveTeamCardRecord(
  storage: WriteStorage | null | undefined,
  records: TeamCardRecords,
  key: string,
  settled: string,
): TeamCardRecords {
  const next = { ...loadTeamCardRecords(storage), ...records, [key]: settled };
  try {
    storage?.setItem(TEAM_CARD_RECORDS_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[hq-desktop] could not save the team card pick:", err);
  }
  return next;
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
