/**
 * "Your team" (visual first run, slice 2): where the person works. Join a
 * company that invited them, keep working in a company they already belong
 * to, start a company, or "Just me".
 *
 * Pure: the choices from the workspace roster (`Workspace`, the same rows
 * the company rail and the invite bell read), the default, the company
 * handle made from a typed name, and the one-action-at-a-time runner the
 * screen uses for Join and Create. The host does the joining
 * (`company.claimPendingInvite`, as the bell's Join does) and the creating
 * (the `create_company` card, as the New company sheet does).
 */

import { dedupeWorkspaces, pendingInviteWorkspaces, type Workspace } from "../workspaces.js";
import type { FirstRunTeamHandoff } from "./visual-first-run.js";

export interface FirstRunTeamCompany {
  /** Cloud uid; null for a company that is only on this computer. */
  companyUid: string | null;
  slug: string;
  name: string;
}

export interface FirstRunTeamOptions {
  /** Companies that invited the person and wait for an answer. */
  invites: readonly FirstRunTeamCompany[];
  /** Companies the person already belongs to. */
  companies: readonly FirstRunTeamCompany[];
}

/** One card on the screen. */
export type FirstRunTeamPick =
  | { kind: "invite"; company: FirstRunTeamCompany }
  | { kind: "existing"; company: FirstRunTeamCompany }
  | { kind: "create" }
  | { kind: "personal" };

/** What the person settled on. */
export type FirstRunTeamChoice =
  | { kind: "personal" }
  | { kind: "company"; how: "joined" | "created" | "existing"; company: FirstRunTeamCompany };

/** Cards before the list asks for a filter (the New bot company grid's bound). */
export const TEAM_CARDS_MAX = 12;
export const COMPANY_NAME_MAX = 60;

export const TEAM_COPY = {
  kicker: "Your team",
  lead: "Who do you",
  em: "work with?",
  copy: "Join a company that invited you, start one, or keep HQ to yourself for now. You can add a company later.",
  personal: "Just me",
  personalNote: "On your own for now.",
  create: "Start a company",
  createNote: "HQ sets it up for you.",
  inviteNote: "Invited you",
  existingNote: "You're a member",
  nameLabel: "Company name",
  filterLabel: "Find a company",
  noMatch: "No company matches that.",
  started: "Started. Next keeps this company.",
} as const;

function label(w: Workspace): string {
  return (w.displayName || w.slug).trim() || w.slug;
}

function toCompany(w: Workspace): FirstRunTeamCompany {
  return { companyUid: (w.cloudUid ?? "").trim() || null, slug: w.slug, name: label(w) };
}

/**
 * The cards from the roster: pending invites, then companies the person is
 * an active member of. The personal vault is never a company here.
 */
export function teamOptionsFrom(workspaces: readonly Workspace[] | null | undefined): FirstRunTeamOptions {
  const rows = dedupeWorkspaces([...(workspaces ?? [])]);
  const invites = pendingInviteWorkspaces(rows).map(toCompany);
  const inviteSlugs = new Set(invites.map((c) => c.slug));
  const companies = rows
    .filter(
      (w) =>
        w.kind === "company" &&
        w.slug !== "personal" &&
        !inviteSlugs.has(w.slug) &&
        w.membershipStatus !== "pending" &&
        (w.membershipStatus === "active" || w.state === "synced" || w.state === "local-only"),
    )
    .map(toCompany);
  return { invites, companies };
}

/**
 * What "Finish with defaults" and an untouched screen settle on: the one
 * company the person already belongs to, else "Just me". An invite is never
 * accepted by default.
 */
export function defaultTeamChoice(options: FirstRunTeamOptions): FirstRunTeamChoice {
  const only = options.companies.length === 1 ? options.companies[0] : null;
  return only ? { kind: "company", how: "existing", company: only } : { kind: "personal" };
}

/** The card the screen opens on, matching the default. */
export function defaultTeamPick(options: FirstRunTeamOptions): FirstRunTeamPick {
  const choice = defaultTeamChoice(options);
  return choice.kind === "company" ? { kind: "existing", company: choice.company } : { kind: "personal" };
}

/** A stable key for a card (keyed lists, test ids). */
export function teamPickKey(pick: FirstRunTeamPick): string {
  if (pick.kind === "invite" || pick.kind === "existing") return `${pick.kind}:${pick.company.slug}`;
  return pick.kind;
}

/** The handoff's view of a choice. */
export function teamHandoff(choice: FirstRunTeamChoice): FirstRunTeamHandoff {
  if (choice.kind === "personal") return { kind: "personal" };
  return { kind: "company", how: choice.how, name: choice.company.name, slug: choice.company.slug };
}

/** The words before a company's label on Done ("Joined ", "Started ", or none). */
export function teamVerb(choice: FirstRunTeamChoice | null): string {
  if (!choice || choice.kind === "personal") return "";
  return choice.how === "joined" ? "Joined " : choice.how === "created" ? "Started " : "";
}

/** The Done summary line for a choice. */
export function teamSummary(choice: FirstRunTeamChoice | null): string {
  if (!choice || choice.kind === "personal") return "Just me";
  if (choice.how === "joined") return `Joined ${choice.company.name}`;
  if (choice.how === "created") return `Started ${choice.company.name}`;
  return choice.company.name;
}

/**
 * The company handle the create card needs, made from the typed name the
 * way the server's rule reads it: lower case letters, digits and single
 * hyphens, starting with a letter, 3 to 40 long. Null when the name has too
 * few letters or digits to make one.
 */
export function companySlugFromName(name: string): string | null {
  const ascii = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return ascii.length >= 3 ? ascii : null;
}

/** Why a typed company name cannot be used, or null. */
export function companyNameIssue(name: string): string | null {
  const flat = name.split(/\s+/).filter(Boolean).join(" ");
  if (!flat) return "Give your company a name.";
  if ([...flat].length > COMPANY_NAME_MAX) return `Keep the name under ${COMPANY_NAME_MAX} characters.`;
  if (!companySlugFromName(flat)) return "Use at least three letters or digits, starting with a letter.";
  return null;
}

// ── one action at a time ───────────────────────────────────────────────────

export type TeamActionResult = { ok: true; choice: FirstRunTeamChoice } | { ok: false; reason: string };

/** Where Join or Create stands, as the screen shows it. */
export type TeamActionState =
  | { state: "idle" }
  | { state: "running"; key: string; label: string }
  | { state: "done"; key: string; choice: FirstRunTeamChoice }
  | { state: "failed"; key: string; label: string; reason: string };

export interface TeamActionRunner {
  /**
   * Run `action` for the card `key`. While one runs, every press does
   * nothing (a double click never joins or creates twice); after one
   * succeeded for the same card, it is not run again.
   */
  run(key: string, label: string, action: () => Promise<TeamActionResult>): void;
  /** Run the failed action again. */
  retry(): void;
  /** Forget a failure (the person picked another card). */
  clear(): void;
  current(): TeamActionState;
}

export const TEAM_GENERIC_FAILURE = "That did not work. Try again in a moment.";

/**
 * How long a join or create may run before the screen calls it failed. The
 * team step comes before "Bring in your context", where the takeover offers
 * no Continue in chat, so a call that never answers must not hold the
 * screen: after this it shows the failure line with Retry, and another card
 * works again.
 */
export const TEAM_ACTION_TIMEOUT_MS = 30_000;

export interface TeamActionRunnerOptions {
  /** Test seam; defaults to TEAM_ACTION_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** `onchange` gets "running" synchronously, so the pending label shows on the same frame as the press. */
export function createTeamActionRunner(
  onchange: (state: TeamActionState) => void,
  opts: TeamActionRunnerOptions = {},
): TeamActionRunner {
  const timeoutMs = opts.timeoutMs ?? TEAM_ACTION_TIMEOUT_MS;
  let state: TeamActionState = { state: "idle" };
  let last: { key: string; label: string; action: () => Promise<TeamActionResult> } | null = null;
  /** The run whose answer still counts; a timed-out run's late answer is ignored. */
  let token = 0;
  const set = (next: TeamActionState): void => {
    state = next;
    onchange(next);
  };
  function run(key: string, label: string, action: () => Promise<TeamActionResult>): void {
    if (state.state === "running") return;
    if (state.state === "done" && state.key === key) return;
    last = { key, label, action };
    const mine = ++token;
    set({ state: "running", key, label });
    const timer = setTimeout(() => {
      if (mine !== token) return;
      token += 1;
      console.warn("[hq-desktop] first-run team action timed out");
      set({ state: "failed", key, label, reason: TEAM_GENERIC_FAILURE });
    }, timeoutMs);
    const settle = (next: TeamActionState): void => {
      clearTimeout(timer);
      if (mine !== token) return;
      token += 1;
      set(next);
    };
    void Promise.resolve()
      .then(action)
      .then(
        (result) =>
          settle(result.ok ? { state: "done", key, choice: result.choice } : { state: "failed", key, label, reason: result.reason }),
        (err: unknown) => {
          console.warn("[hq-desktop] first-run team action threw:", err);
          settle({ state: "failed", key, label, reason: TEAM_GENERIC_FAILURE });
        },
      );
  }
  return {
    run,
    retry() {
      if (state.state === "failed" && last) {
        const { key, label, action } = last;
        set({ state: "idle" });
        run(key, label, action);
      }
    },
    clear() {
      if (state.state === "failed") set({ state: "idle" });
    },
    current: () => state,
  };
}
