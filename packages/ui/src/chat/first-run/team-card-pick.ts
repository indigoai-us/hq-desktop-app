/**
 * What a pick on the team card does, apart from where it is drawn: run the
 * team-step runner for it (join, create, pin), then tell the setup bot what
 * the person chose, once, through the card-action path.
 *
 * DesktopApp renders TeamCard and hands its picks here; this keeps that file's
 * hunk to the render and the deps.
 */
import type { FirstRunTeamHost } from "./first-run-hosts";
import { teamCardPickKey, teamCardSettledLine, type FirstRunTeamChoice, type TeamCardPick } from "./team-step";

export interface TeamCardPickDeps {
  host: FirstRunTeamHost;
  /** Pin a company the person already belongs to. */
  pin: (companyUid: string | null) => void | Promise<void>;
  /** Reply to the setup bot. Sent at most once per idempotency key. */
  reply: (text: string, idempotencyKey: string) => void | Promise<void>;
}

export type TeamCardPickResult = { ok: true; settled: string; choice: FirstRunTeamChoice } | { ok: false; reason: string };

/** Shown when a runner throws instead of answering: never the raw error. */
export const TEAM_CARD_FAILURE = "Something went wrong. Try again.";

/** What the bot reads after the pick, in the person's voice. */
export function teamCardReplyText(choice: FirstRunTeamChoice): string {
  if (choice.kind === "personal") return "Just me for now.";
  if (choice.how === "created") return `I created ${choice.company.name}.`;
  if (choice.how === "joined") return `I joined ${choice.company.name}.`;
  return `I opened ${choice.company.name}.`;
}

export function teamCardIdempotencyKey(pick: TeamCardPick): string {
  return `first-run-team:${teamCardPickKey(pick)}`;
}

export async function runTeamCardPick(pick: TeamCardPick, deps: TeamCardPickDeps): Promise<TeamCardPickResult> {
  let choice: FirstRunTeamChoice;
  try {
    if (pick.kind === "personal") {
      choice = { kind: "personal" };
    } else if (pick.kind === "existing") {
      await deps.pin(pick.company.companyUid);
      choice = { kind: "company", how: "existing", company: pick.company };
    } else {
      const result = pick.kind === "invite" ? await deps.host.join(pick.company) : await deps.host.create(pick.name);
      if (!result.ok) return { ok: false, reason: result.reason || TEAM_CARD_FAILURE };
      choice = result.choice;
    }
  } catch {
    return { ok: false, reason: TEAM_CARD_FAILURE };
  }
  await deps.reply(teamCardReplyText(choice), teamCardIdempotencyKey(pick));
  return { ok: true, settled: teamCardSettledLine(choice), choice };
}
