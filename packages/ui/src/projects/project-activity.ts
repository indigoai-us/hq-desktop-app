/**
 * Project activity for the portfolio Active column.
 *
 * Active used to need a live MQTT session push that matched the project while
 * the page was open. The page started with no sessions, pushes were keyed by
 * story id, and pushes for other projects were dropped while one was open, so
 * Active stayed empty. Active now means real activity now or very recly,
 * from any one of these signals:
 *
 * - presence: a work-mesh session bound to the project with a turn in the last
 *   `presenceWindowMs` (default 30 minutes), from the live read or a push;
 * - lane: the same, when the actor is an agent or lane;
 * - story: the project's PRD on this computer changed, or a story moved to
 *   in progress / review, in the last `recentWindowMs` (default 24 hours);
 * - commit: a commit on the project's branch in the last `recentWindowMs`.
 *
 * The freshest qualifying signal wins and its label is shown on the card.
 */

import type { LiveReadResponse } from "@hq/core";
import type { PortfolioSessionRef, Project } from "./projects-model.js";
import { isPortfolioLiveStatus } from "./projects-model.js";
import { isRawPersonId } from "../common/people/people.js";

export const ACTIVE_PRESENCE_WINDOW_MS = 30 * 60 * 1000;
export const ACTIVE_RECENT_WORK_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ProjectActivityKind = "presence" | "lane" | "story" | "commit";

export interface ProjectActivity {
  kind: ProjectActivityKind;
  /** Epoch ms of the signal. */
  at: number;
  /** Quiet card line, e.g. "active · Corey, 4 min ago". */
  label: string;
}

/** A story status change seen on the work mesh. */
export interface ProjectStoryMove {
  projectId: string;
  status: string;
  at: string;
}

/** A commit on a project's branch. */
export interface ProjectCommit {
  projectId: string;
  at: string;
}

export interface ProjectActivitySignals {
  now: number;
  /** Company-wide work-mesh live read for this project's company. */
  live?: LiveReadResponse | null;
  /** Session markers from work-mesh pushes received while the page is open. */
  sessions?: readonly PortfolioSessionRef[];
  storyMoves?: readonly ProjectStoryMove[];
  commits?: readonly ProjectCommit[];
  presenceWindowMs?: number;
  recentWindowMs?: number;
  /** Resolve an actor uid to a person's name (company roster), when known. */
  nameFor?: (actorUid: string) => string | null | undefined;
}

/** A participant's readable name, or null when only a raw id is known. */
function participantName(
  participant: { actorUid: string; displayName?: string | null },
  nameFor: ProjectActivitySignals["nameFor"],
): string | null {
  const shown = participant.displayName?.trim() ?? "";
  if (shown && !isRawPersonId(shown)) return shown;
  const resolved = nameFor?.(participant.actorUid)?.trim() ?? "";
  if (resolved && !isRawPersonId(resolved)) return resolved;
  return null;
}

type ProjectRef = Pick<Project, "id" | "prdPath"> &
  Partial<Pick<Project, "prdModifiedAt">>;

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Ids a project answers to: the board id (e.g. `in-proj-233`) and the folder
 * slug that holds its prd.json (e.g. `hq-profile-attribution-emitter`). The
 * work mesh keys projects by either, depending on who registered them.
 */
export function projectIdAliases(project: Pick<Project, "id" | "prdPath">): Set<string> {
  const ids = new Set<string>();
  const id = norm(project.id);
  if (id) ids.add(id);
  const parts = (project.prdPath ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2 && parts.at(-1) === "prd.json") {
    const folder = norm(parts.at(-2));
    if (folder) ids.add(folder);
  }
  return ids;
}

export function projectIdMatches(
  project: Pick<Project, "id" | "prdPath">,
  candidate: string | null | undefined,
): boolean {
  const c = norm(candidate);
  return c !== "" && projectIdAliases(project).has(c);
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** "now", "4 min ago", "3h ago", "2d ago". */
export function agoLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function within(at: number, now: number, windowMs: number): boolean {
  return at > 0 && at <= now + 60_000 && now - at < windowMs;
}

const MOVED_STATUSES = new Set(["in_progress", "in-progress", "review"]);

/** Freshest qualifying activity for a project, or null when it is quiet. */
export function projectActivity(
  project: ProjectRef,
  signals: ProjectActivitySignals,
): ProjectActivity | null {
  const now = signals.now;
  const presenceWindow = signals.presenceWindowMs ?? ACTIVE_PRESENCE_WINDOW_MS;
  const recentWindow = signals.recentWindowMs ?? ACTIVE_RECENT_WORK_WINDOW_MS;
  const found: ProjectActivity[] = [];

  for (const participant of signals.live?.participants ?? []) {
    for (const session of participant.sessions) {
      if (!projectIdMatches(project, session.projectId)) continue;
      if (norm(session.status) === "ended") continue;
      const at = ms(session.lastTurnAt) || ms(session.startedAt);
      if (!within(at, now, presenceWindow)) continue;
      const who = participantName(participant, signals.nameFor);
      found.push(
        participant.actorType === "agent"
          ? { kind: "lane", at, label: who ? `active · lane ${who}` : "active · 1 live session" }
          : {
              kind: "presence",
              at,
              label: who
                ? `active · ${who}, ${agoLabel(at, now)}`
                : `active · 1 live session, ${agoLabel(at, now)}`,
            },
      );
    }
  }

  for (const session of signals.sessions ?? []) {
    if (!projectIdMatches(project, session.project)) continue;
    const at = ms(session.lastActivityAt) || ms(session.startedAt);
    if (!isPortfolioLiveStatus(session.status) || !within(at, now, presenceWindow)) {
      continue;
    }
    const named = session.agent?.trim();
    const agent = named && !isRawPersonId(named) ? named : undefined;
    found.push(
      agent
        ? { kind: "lane", at, label: `active · lane ${agent}` }
        : { kind: "presence", at, label: `active · ${agoLabel(at, now)}` },
    );
  }

  for (const move of signals.storyMoves ?? []) {
    if (!projectIdMatches(project, move.projectId)) continue;
    if (!MOVED_STATUSES.has(norm(move.status))) continue;
    const at = ms(move.at);
    if (within(at, now, recentWindow)) {
      found.push({ kind: "story", at, label: `story moved ${agoLabel(at, now)}` });
    }
  }

  const prdAt = ms(project.prdModifiedAt);
  if (within(prdAt, now, recentWindow)) {
    found.push({ kind: "story", at: prdAt, label: `stories updated ${agoLabel(prdAt, now)}` });
  }

  for (const commit of signals.commits ?? []) {
    if (!projectIdMatches(project, commit.projectId)) continue;
    const at = ms(commit.at);
    if (within(at, now, recentWindow)) {
      found.push({ kind: "commit", at, label: `last commit ${agoLabel(at, now)}` });
    }
  }

  if (found.length === 0) return null;
  // Live presence outranks recent work; within a tier the freshest wins.
  const tier = (a: ProjectActivity) => (a.kind === "presence" || a.kind === "lane" ? 0 : 1);
  found.sort((a, b) => tier(a) - tier(b) || b.at - a.at);
  return found[0];
}
