/**
 * Finding the bot a cancelled create may have made, by reading only.
 *
 * When a create is cancelled and its answer never arrives, the app does not
 * know whether a bot exists. It must not send the create again to find out:
 * if the first request never reached the server, a second one would make the
 * bot the person just cancelled (review A-C5, second round).
 *
 * So Cancel reads the company's bots, the member-safe roster the app already
 * reads elsewhere (`GET /v1/agents/mobile-roster?companyUid=`,
 * `agents.listMobileRoster`), and looks for the handle the create was sent
 * with. A bot's `slug` on that roster is its handle, and a handle is held by
 * one bot per company.
 *
 * A bot with that handle is only taken as the one this create made when it
 * was not there before the create was sent. That is what the baseline is
 * for: the same roster, read at the moment Create bot is pressed. Without a
 * readable baseline, or when the bot is on the baseline, the bot may be an
 * older one that merely has the same handle, and it is never removed on that
 * evidence.
 */

export interface RosterBot {
  agentUid: string;
  /** The bot's handle: its `slug` on the roster, lowercased. */
  handle: string;
  /** Empty when the row does not say. */
  companyUid: string;
  /** The setup phase, lowercased. Empty when the row does not say. */
  phase: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The bots on a roster answer. Takes the adapter's result (`{ ok, value }`)
 * or the bare payload. Null when the read failed or the answer is not a
 * roster: "could not read" is never read as "no bots".
 */
export function rosterBots(answer: unknown): RosterBot[] | null {
  const outer = record(answer);
  let payload: unknown = answer;
  if (outer && typeof outer.ok === "boolean") {
    if (outer.ok !== true) return null;
    payload = outer.value;
  }
  const body = record(payload);
  const list = Array.isArray(payload) ? payload : body && Array.isArray(body.agents) ? body.agents : null;
  if (!list) return null;
  const bots: RosterBot[] = [];
  for (const entry of list) {
    const row = record(entry);
    const agentUid = text(row?.agentUid) || text(row?.uid);
    if (!row || !agentUid) continue;
    bots.push({
      agentUid,
      handle: text(row.slug).toLowerCase(),
      companyUid: text(row.companyUid),
      phase: (text(row.setupPhase) || text(row.status)).toLowerCase(),
    });
  }
  return bots;
}

/** The ids of the bots that were on the roster when Create bot was pressed. Null when it could not be read. */
export function rosterBaseline(answer: unknown): ReadonlySet<string> | null {
  const bots = rosterBots(answer);
  return bots ? new Set(bots.map((bot) => bot.agentUid)) : null;
}

export type CreatedBotLookup =
  /** A bot with the handle that was not there before the create was sent. */
  | { kind: "found"; agentUid: string }
  /** The roster was read and holds no bot with the handle. The request may still be running. */
  | { kind: "absent" }
  /**
   * A bot has the handle, and nothing shows this create made it: it was
   * there before, or there is no baseline to compare with.
   */
  | { kind: "unproven" }
  /** The roster could not be read. */
  | { kind: "unreadable" };

/** Look for the bot a create made, on a roster answer read after Cancel. */
export function findCreatedBot(input: {
  roster: unknown;
  companyUid: string;
  handle: string;
  baseline: ReadonlySet<string> | null;
}): CreatedBotLookup {
  const bots = rosterBots(input.roster);
  if (!bots) return { kind: "unreadable" };
  const companyUid = input.companyUid.trim();
  const handle = input.handle.trim().toLowerCase();
  if (!handle) return { kind: "absent" };
  const match = bots.find(
    (bot) =>
      bot.handle === handle &&
      // The read is scoped to the company. A row that names another company is not this one's bot.
      (!bot.companyUid || bot.companyUid === companyUid) &&
      bot.phase !== "deprovisioning" &&
      bot.phase !== "deprovisioned",
  );
  if (!match) return { kind: "absent" };
  if (!input.baseline || input.baseline.has(match.agentUid)) return { kind: "unproven" };
  return { kind: "found", agentUid: match.agentUid };
}

/**
 * True when a status read says the bot belongs to somebody else. The server
 * records the person who created a bot as its owner (`agent.ownerUid`).
 * Only a clear mismatch between two person ids counts: an answer that does
 * not say, or ids of another kind, decide nothing.
 */
export function createdByAnotherPerson(statusAnswer: unknown, viewerUid: string | null | undefined): boolean {
  const outer = record(statusAnswer);
  if (!outer || outer.ok !== true) return false;
  const owner = text(record(record(outer.value)?.agent)?.ownerUid);
  const viewer = (viewerUid ?? "").trim();
  return owner.startsWith("prs_") && viewer.startsWith("prs_") && owner !== viewer;
}
