/**
 * What a pick on the team card does, apart from where it is drawn: run the
 * team-step runner for it (join, create, pin), then tell the setup bot what
 * the person chose, once, through the card-action path.
 *
 * DesktopApp renders TeamCard and hands its picks here; this keeps that file's
 * hunk to the render and the deps.
 */
import type { FirstRunTeamHost } from "./first-run-hosts";
import { formatTeamCardReplyAbandoned } from "./first-run-timing";
import { loadTeamCardCreating, loadTeamCardUnsentCreate, type TeamCardCreating } from "./team-card-record";
import {
  companySlugFromName,
  teamCardPickIdentity,
  teamCardSettledLine,
  type FirstRunTeamChoice,
  type FirstRunTeamCompany,
  type TeamCardPick,
} from "./team-step";

export interface TeamCardPickDeps {
  host: FirstRunTeamHost;
  /** The setup bot the card was drawn for: scopes the reply's idempotency key. */
  agentUid: string;
  /** Pin a company the person already belongs to. */
  pin: (companyUid: string | null) => void | Promise<void>;
  /** Reply to the setup bot. Sent at most once per idempotency key; throws when the send fails. */
  reply: (text: string, idempotencyKey: string) => void | Promise<void>;
  /** The runner already succeeded for this pick and only the reply failed: resend without running it again. */
  completed?: FirstRunTeamChoice;
  /** How many sends of this pick's reply have failed so far. */
  replyFailures?: number;
  /**
   * An earlier create of this name was sent and never answered with a
   * company: it may have made one anyway, so look for it before creating.
   */
  unresolved?: boolean;
  /**
   * The unresolved create was sent again and the server refused it: the slug
   * is taken, most likely by the company the first create made. Only look for
   * that company; never create again.
   */
  refused?: boolean;
  /** Presses so far that looked for the unresolved create's company and did not find it. */
  failedLooks?: number;
  /**
   * The name of an earlier create whose company was never found, after the
   * card was unlocked: a create looks for that company first, so a late find
   * still settles the card.
   */
  lookupHint?: string;
  /**
   * Whether the server says this slug is taken by someone else's company (the
   * check is per person: their own company never reads as taken). Unknown or
   * failed reads are false.
   */
  slugTaken?: (slug: string) => Promise<boolean>;
  /** Keep the count of failed looks with the pending create, so a restart does not reset the bound. */
  looked?: (failedLooks: number) => void;
  /**
   * Keep a create before it is sent, so a timeout, a failure or a restart
   * after the server made the company never leads to a second one.
   */
  creating?: (pending: TeamCardCreating) => void;
  /** The create kept by `creating` is known to have made no company. */
  notCreating?: () => void;
  /**
   * A create just made a company, before its reply is sent: keep it, so a
   * failed reply or a restart never creates a second one.
   */
  created?: (choice: FirstRunTeamChoice) => void;
  /** One first-run log line. */
  log?: (line: string) => void;
}

/** The last pick on the card and, when only its reply failed, what it produced. */
export interface TeamCardLastPick {
  pick: TeamCardPick;
  completed?: FirstRunTeamChoice;
  /** The pick was a create whose outcome is unknown: the card stays on its name. */
  creating?: boolean;
  /** That create came back refused after an unresolved one: presses only look for the company. */
  refused?: boolean;
  /** Presses that looked for that create's company and did not find it. */
  failedLooks?: number;
  /** The card was unlocked with that create's company never found: its name, to look for on the next create. */
  lookupHint?: string;
  /** How many sends of the reply have failed. */
  replyFailures?: number;
}

/**
 * Sends of a reply before the card settles without it: the first try and two
 * Retries. The pick itself already happened; only the bot's copy is missing.
 */
export const TEAM_CARD_REPLY_TRIES = 3;

/**
 * Presses that look for an unresolved create's company without finding it
 * before the card unlocks, so it is never held on Retry alone: rename, "Just
 * me for now", Join and Open come back, and the name is kept as a lookup hint.
 */
export const TEAM_CARD_LOOK_TRIES = 2;

/**
 * What a press runs, given the last pick. Once a create has made a company,
 * every press resends that company's reply under the original pick (a new
 * name, or another card, never provisions again). While a create's outcome is
 * unknown, every press first looks for that company under the original name
 * (and, once a create of it was refused, only looks). After the card unlocks
 * on a lookup hint, a create of the same name is that unresolved create on its
 * last look, and a create of another name looks for the hinted company first.
 * A failed join or open is resent only when the same card is pressed again.
 */
export function teamCardResume(
  pick: TeamCardPick,
  last: TeamCardLastPick | null,
): {
  pick: TeamCardPick;
  completed?: FirstRunTeamChoice;
  replyFailures?: number;
  unresolved?: boolean;
  refused?: boolean;
  failedLooks?: number;
  lookupHint?: string;
} {
  if (!last) return { pick };
  const done = last.completed;
  if (last.pick.kind === "create" && done?.kind === "company")
    return { pick: last.pick, completed: done, replyFailures: last.replyFailures };
  if (last.pick.kind === "create" && last.creating)
    return {
      pick: last.pick,
      unresolved: true,
      ...(last.refused ? { refused: true } : {}),
      ...(last.failedLooks ? { failedLooks: last.failedLooks } : {}),
    };
  if (last.lookupHint && pick.kind === "create") {
    const hinted = companySlugFromName(last.lookupHint);
    if (hinted && companySlugFromName(pick.name) === hinted)
      return { pick, unresolved: true, failedLooks: TEAM_CARD_LOOK_TRIES - 1 };
    return { pick, lookupHint: last.lookupHint };
  }
  if (done && teamCardPickIdentity(last.pick) === teamCardPickIdentity(pick))
    return { pick, completed: done, replyFailures: last.replyFailures };
  return { pick };
}

/** What storage holds for the card after a restart: a company a create made, or a create still unresolved. */
export function teamCardStoredLast(storage: Pick<Storage, "getItem"> | null | undefined, key: string): TeamCardLastPick | null {
  const unsent = loadTeamCardUnsentCreate(storage, key);
  if (unsent)
    return {
      pick: { kind: "create", name: unsent.name },
      completed: { kind: "company", how: "created", company: unsent.created },
      ...(unsent.replyFailures ? { replyFailures: unsent.replyFailures } : {}),
    };
  const pending = loadTeamCardCreating(storage, key);
  if (!pending) return null;
  const pick: TeamCardPick = { kind: "create", name: pending.name };
  const failedLooks = pending.failedLooks ?? 0;
  if (failedLooks >= TEAM_CARD_LOOK_TRIES) return { pick, lookupHint: pending.name };
  return { pick, creating: true, ...(failedLooks ? { failedLooks } : {}) };
}

/** The name the card is held on: a create made that company, or may have. */
export function teamCardLockName(last: TeamCardLastPick | null): string | null {
  if (last?.pick.kind !== "create") return null;
  if (last.completed?.kind === "company") return last.completed.company.name;
  return last.creating ? last.pick.name : null;
}

export type TeamCardPickResult =
  | { ok: true; settled: string; choice: FirstRunTeamChoice }
  | {
      ok: false;
      reason: string;
      completed?: FirstRunTeamChoice;
      creating?: boolean;
      refused?: boolean;
      failedLooks?: number;
      lookupHint?: string;
      replyFailures?: number;
    };

/** Shown when a runner throws instead of answering: never the raw error. */
export const TEAM_CARD_FAILURE = "Something went wrong. Try again.";

/** What the bot reads after the pick, in the person's voice. */
export function teamCardReplyText(choice: FirstRunTeamChoice): string {
  if (choice.kind === "personal") return "Just me for now.";
  if (choice.how === "created") return `I created ${choice.company.name}.`;
  if (choice.how === "joined") return `I joined ${choice.company.name}.`;
  return `I opened ${choice.company.name}.`;
}

/** One key per bot and pick; a create with another name is another pick. */
export function teamCardIdempotencyKey(pick: TeamCardPick, agentUid: string): string {
  return `first-run-team:${agentUid.trim()}:${teamCardPickIdentity(pick)}`;
}

/** Keeping the card's state is best effort: a storage failure must not read as a failed pick. */
function keep(what: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    console.warn(`[hq-desktop] could not keep the ${what} for the team card:`, err);
  }
}

/** The company exists now, however it was found: lock the card on it. */
function keepCreated(deps: TeamCardPickDeps, company: FirstRunTeamCompany): FirstRunTeamChoice {
  const choice: FirstRunTeamChoice = { kind: "company", how: "created", company };
  keep("created company", () => deps.created?.(choice));
  return choice;
}

async function findCreated(host: FirstRunTeamHost, name: string): Promise<FirstRunTeamCompany | null> {
  try {
    return (await host.findCreated?.(name)) ?? null;
  } catch (err) {
    console.warn("[hq-desktop] team card could not look for the company:", err);
    return null;
  }
}

type CreateOutcome =
  | { ok: true; choice: FirstRunTeamChoice }
  | { ok: false; reason: string; creating?: boolean; refused?: boolean; failedLooks?: number; lookupHint?: string };

/** Look for the company an earlier create of `name` may have made; lock the card on it when found. */
async function findAndKeep(name: string, deps: TeamCardPickDeps): Promise<FirstRunTeamChoice | null> {
  const found = await findCreated(deps.host, name);
  if (!found) return null;
  // Pinned as a create pins it; the company exists either way.
  keep("found company's pin", () =>
    void Promise.resolve(deps.pin(found.companyUid)).catch((err) =>
      console.warn("[hq-desktop] could not pin the found company for the team card:", err),
    ),
  );
  return keepCreated(deps, found);
}

/**
 * A press looked for the unresolved create's company and did not find it.
 * Under the bound the card stays on the name and Retry looks again; at the
 * bound it unlocks with the same error line, keeping the name as a lookup hint.
 */
function lookFailed(name: string, deps: TeamCardPickDeps, refused: boolean, reason = TEAM_CARD_FAILURE): CreateOutcome {
  const failedLooks = (deps.failedLooks ?? 0) + 1;
  keep("failed look count", () => deps.looked?.(failedLooks));
  if (failedLooks >= TEAM_CARD_LOOK_TRIES) return { ok: false, reason, lookupHint: name };
  return { ok: false, reason, creating: true, ...(refused ? { refused: true } : {}), failedLooks };
}

/** True only when the server says someone else has the slug. */
async function takenByOther(slug: string, deps: TeamCardPickDeps): Promise<boolean> {
  try {
    return (await deps.slugTaken?.(slug)) === true;
  } catch (err) {
    console.warn("[hq-desktop] team card could not check the company handle:", err);
    return false;
  }
}

/**
 * Create once. The create is kept before it is sent; until a company comes of
 * it, or the server refuses a create that was never unresolved, its outcome
 * stays unknown and the next press looks for the company before creating
 * again. A refusal after an unresolved create is not proof that nothing was
 * made: the slug may be taken by that very company. When the server says the
 * slug is someone else's, nothing of the person's was made: the marker is
 * cleared and the card unlocks so they can rename. Otherwise the card stays
 * locked and only looks for it, for at most `TEAM_CARD_LOOK_TRIES` presses.
 */
async function createOnce(name: string, deps: TeamCardPickDeps): Promise<CreateOutcome> {
  if (deps.unresolved) {
    const found = await findAndKeep(name, deps);
    if (found) return { ok: true, choice: found };
    if (deps.refused) return lookFailed(name, deps, true);
    // Not in the roster within the bound: the earlier create may have made
    // nothing. The create below keeps the same name again before it is sent.
  } else if (deps.lookupHint) {
    const found = await findAndKeep(deps.lookupHint, deps);
    if (found) return { ok: true, choice: found };
  }
  const slug = companySlugFromName(name);
  const failedLooks = deps.unresolved ? deps.failedLooks : undefined;
  if (slug) keep("pending create", () => deps.creating?.({ name, slug, ...(failedLooks ? { failedLooks } : {}) }));
  let result;
  try {
    result = await deps.host.create(name);
  } catch (err) {
    console.warn("[hq-desktop] team card create failed:", err);
    if (deps.unresolved) return lookFailed(name, deps, false);
    return { ok: false, reason: TEAM_CARD_FAILURE, creating: true };
  }
  if (!result.ok) {
    if (!result.blocked) {
      const reason = result.reason || TEAM_CARD_FAILURE;
      return deps.unresolved ? lookFailed(name, deps, false, reason) : { ok: false, reason, creating: true };
    }
    if (deps.unresolved) {
      if (slug && (await takenByOther(slug, deps))) {
        keep("refused create", () => deps.notCreating?.());
        return { ok: false, reason: result.reason || TEAM_CARD_FAILURE };
      }
      const found = await findAndKeep(name, deps);
      return found ? { ok: true, choice: found } : lookFailed(name, deps, true);
    }
    keep("refused create", () => deps.notCreating?.());
    return { ok: false, reason: result.reason || TEAM_CARD_FAILURE };
  }
  if (result.choice.kind !== "company") return { ok: true, choice: result.choice };
  return { ok: true, choice: keepCreated(deps, result.choice.company) };
}

export async function runTeamCardPick(pick: TeamCardPick, deps: TeamCardPickDeps): Promise<TeamCardPickResult> {
  let choice: FirstRunTeamChoice;
  try {
    if (deps.completed) {
      choice = deps.completed;
    } else if (pick.kind === "personal") {
      choice = { kind: "personal" };
    } else if (pick.kind === "existing") {
      await deps.pin(pick.company.companyUid);
      choice = { kind: "company", how: "existing", company: pick.company };
    } else if (pick.kind === "invite") {
      const result = await deps.host.join(pick.company);
      if (!result.ok) return { ok: false, reason: result.reason || TEAM_CARD_FAILURE };
      choice = result.choice;
    } else {
      const made = await createOnce(pick.name, deps);
      if (!made.ok) return made;
      choice = made.choice;
    }
  } catch (err) {
    console.warn("[hq-desktop] team card pick failed:", err);
    return { ok: false, reason: TEAM_CARD_FAILURE };
  }
  try {
    await deps.reply(teamCardReplyText(choice), teamCardIdempotencyKey(pick, deps.agentUid));
  } catch (err) {
    console.warn("[hq-desktop] could not send the team card reply to the setup bot:", err);
    const replyFailures = (deps.replyFailures ?? 0) + 1;
    if (replyFailures < TEAM_CARD_REPLY_TRIES) return { ok: false, reason: TEAM_CARD_FAILURE, completed: choice, replyFailures };
    // Every Retry failed: settle on what happened, without the bot's copy.
    keep("log line", () => deps.log?.(formatTeamCardReplyAbandoned()));
  }
  return { ok: true, settled: teamCardSettledLine(choice), choice };
}

/**
 * The reply side of the card: each key is sent at most once, and a key is
 * kept only when its send succeeds, so Retry after a failed send sends again.
 * `target` is where the pick was made, passed through to `send` so the reply
 * goes there whatever is open when it is sent.
 */
export function createTeamCardReplies<T>(send: (text: string, key: string, target: T) => Promise<unknown>) {
  const sent = new Set<string>();
  const inFlight = new Set<string>();
  return async (text: string, key: string, target: T): Promise<void> => {
    if (sent.has(key) || inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await send(text, key, target);
      sent.add(key);
    } finally {
      inFlight.delete(key);
    }
  };
}
