/**
 * Goals page model (console-rail US-026).
 *
 * Reads the objective shape from board.json (via loadCompanyGoals).
 * Progress is the average of key results that have numeric current/target.
 * Link assignments are a session overlay: board.json has no project field
 * on key results, and there is no write command.
 */

import type { KeyResult, Objective } from "../projects/local-projects.js";
import type { Project } from "../projects/projects-model.js";

export type GoalPeriod = "2026" | "H2" | "All time";

export const GOAL_PERIODS: readonly GoalPeriod[] = ["2026", "H2", "All time"];

export const NEW_GOAL_PERIODS = ["2026", "H2 2026", "Q4 2026"] as const;

export interface GoalGlyph {
  mark: string;
  label: string;
}

export interface KrLink {
  objectiveId: string;
  krKey: string;
  projectId: string;
  projectName: string;
}

/** Scroll budget for the objective list and the link picker. */
export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export function goalGlyph(status: string): GoalGlyph {
  const value = status.trim().toLowerCase().replaceAll(" ", "_");
  if (value.includes("complete") || value === "done") return { mark: "✓", label: "complete" };
  if (value.includes("off") || value.includes("behind")) return { mark: "○", label: "off track" };
  if (value.includes("risk")) return { mark: "◐", label: "at risk" };
  if (value.includes("track") || value === "active" || value === "on") {
    return { mark: "●", label: "on track" };
  }
  return { mark: "○", label: status.trim() || "not started" };
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** 0–100 when both ends are numeric. Null when the KR has no measurable pair. */
export function krProgress(kr: KeyResult): number | null {
  const current = asNumber(kr.current);
  const target = asNumber(kr.target);
  if (current == null || target == null || target === 0) return null;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

export function objectiveProgress(objective: Objective): number | null {
  const parts = objective.keyResults
    .map(krProgress)
    .filter((n): n is number => n != null);
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) / parts.length);
}

export function krKey(kr: KeyResult, index: number): string {
  return kr.id || kr.title || `kr-${index}`;
}

export function matchesPeriod(timeframe: string, period: GoalPeriod): boolean {
  if (period === "All time") return true;
  const tf = timeframe.toLowerCase();
  if (!tf) return true;
  if (period === "H2") return tf.includes("h2");
  return tf.includes("2026");
}

export function tallyGlyphs(objectives: readonly Objective[]): string {
  const counts = { on: 0, risk: 0, off: 0, complete: 0 };
  for (const objective of objectives) {
    const label = goalGlyph(objective.status).label;
    if (label === "on track") counts.on += 1;
    else if (label === "at risk") counts.risk += 1;
    else if (label === "off track") counts.off += 1;
    else if (label === "complete") counts.complete += 1;
  }
  const parts: string[] = [];
  if (counts.on) parts.push(`● ${counts.on} on track`);
  if (counts.risk) parts.push(`◐ ${counts.risk} at risk`);
  if (counts.off) parts.push(`○ ${counts.off} off track`);
  if (counts.complete) parts.push(`✓ ${counts.complete} complete`);
  return parts.join(" · ");
}

export function krCount(objectives: readonly Objective[]): number {
  return objectives.reduce((sum, objective) => sum + objective.keyResults.length, 0);
}

export function linkedProjectIds(links: readonly KrLink[]): Set<string> {
  return new Set(links.map((link) => link.projectId));
}

export function unlinkedProjects(projects: readonly Project[], links: readonly KrLink[]): Project[] {
  const linked = linkedProjectIds(links);
  return projects.filter((project) => !linked.has(project.id));
}

export function linksForKr(
  links: readonly KrLink[],
  objectiveId: string,
  key: string,
): KrLink[] {
  return links.filter((link) => link.objectiveId === objectiveId && link.krKey === key);
}

export function formatKrEnds(kr: KeyResult): string {
  const current = kr.current ?? "—";
  const target = kr.target ?? "—";
  const unit = kr.unit ? ` ${kr.unit}` : "";
  return `${current} / ${target}${unit}`;
}

const CACHE_PREFIX = "hq-goals-cache:";

export interface GoalsCache {
  objectives: Objective[];
  links: KrLink[];
}

export function readGoalsCache(storage: Storage | null, slug: string): GoalsCache | null {
  if (!storage || !slug) return null;
  try {
    const raw = storage.getItem(CACHE_PREFIX + slug);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GoalsCache;
    if (!parsed || !Array.isArray(parsed.objectives)) return null;
    return {
      objectives: parsed.objectives,
      links: Array.isArray(parsed.links) ? parsed.links : [],
    };
  } catch {
    return null;
  }
}

export function writeGoalsCache(storage: Storage | null, slug: string, cache: GoalsCache): void {
  if (!storage || !slug) return;
  try {
    storage.setItem(CACHE_PREFIX + slug, JSON.stringify(cache));
  } catch {
    /* best-effort */
  }
}
