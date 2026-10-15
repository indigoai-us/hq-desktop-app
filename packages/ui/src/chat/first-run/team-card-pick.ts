/**
 * What a pick on the team card does, apart from where it is drawn: run the
 * team-step runner for it (join, create, pin), then tell the setup bot what
 * the person chose, once, through the card-action path.
 *
 * DesktopApp renders TeamCard and hands its picks here; this keeps that file's
 * hunk to the render and the deps.
 */
import type { FirstRunTeamHost } from "./first-run-hosts";
import { teamCardPickIdentity, teamCardSettledLine, type FirstRunTeamChoice, type TeamCardPick } from "./team-step";

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
}

export type TeamCardPickResult =
  | { ok: true; settled: string; choice: FirstRunTeamChoice }
  | { ok: false; reason: string; completed?: FirstRunTeamChoice };

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
    } else {
      const result = pick.kind === "invite" ? await deps.host.join(pick.company) : await deps.host.create(pick.name);
      if (!result.ok) return { ok: false, reason: result.reason || TEAM_CARD_FAILURE };
      choice = result.choice;
    }
  } catch (err) {
    console.warn("[hq-desktop] team card pick failed:", err);
    return { ok: false, reason: TEAM_CARD_FAILURE };
  }
  try {
    await deps.reply(teamCardReplyText(choice), teamCardIdempotencyKey(pick, deps.agentUid));
  } catch (err) {
    console.warn("[hq-desktop] could not send the team card reply to the setup bot:", err);
    return { ok: false, reason: TEAM_CARD_FAILURE, completed: choice };
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
