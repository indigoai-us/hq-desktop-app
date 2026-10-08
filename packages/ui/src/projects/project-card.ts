/**
 * Pure helpers for the project card's metadata: repo chips, the stories
 * line and the "updated" time. Built only from fields the local project
 * read already carries; nothing here is synthesized.
 */
import type { Project } from "./projects-model.js";

export interface RepoChips {
  /** Chips drawn on the card. */
  shown: string[];
  /** How many more repos the "+N" chip stands for. */
  more: number;
  /** Every repo, for the "+N" chip's title. */
  all: string[];
}

/** First `max` repos as chips, the rest folded into "+N". */
export function repoChips(repos: readonly string[], max = 2): RepoChips {
  const all: string[] = [];
  for (const repo of repos) {
    const name = repo.trim();
    if (name && !all.includes(name)) all.push(name);
  }
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max), all };
}

/** "7 of 15 stories", "1 of 1 story", or null when the PRD has no stories. */
export function storiesLabel(complete: number, total: number): string | null {
  if (total <= 0) return null;
  return `${Math.min(complete, total)} of ${total} ${total === 1 ? "story" : "stories"}`;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "updated 3 min ago" / "updated 2d ago" inside a month, then the date
 * ("updated Jun 8", with the year when it is not this year). Null when the
 * time is unknown or unparseable.
 */
export function updatedLabel(iso: string | null | undefined, now: number): string | null {
  const at = ms(iso);
  if (at === 0) return null;
  const age = now - at;
  if (age < 30 * DAY_MS) {
    const minutes = Math.max(0, Math.floor(age / 60_000));
    if (minutes < 1) return "updated now";
    if (minutes < 60) return `updated ${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `updated ${hours}h ago`;
    return `updated ${Math.floor(hours / 24)}d ago`;
  }
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const text = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `updated ${text}`;
}

/**
 * Freshest known update for the card's "updated" line: the PRD's last write
 * on this computer or the board/PRD `updatedAt`, whichever is newer. Null
 * when neither is known.
 */
export function projectUpdatedAt(
  project: Pick<Project, "updatedAt" | "prdModifiedAt">,
): string | null {
  const local = ms(project.prdModifiedAt);
  const declared = ms(project.updatedAt);
  if (local === 0 && declared === 0) return null;
  return local >= declared ? (project.prdModifiedAt ?? null) : (project.updatedAt ?? null);
}
