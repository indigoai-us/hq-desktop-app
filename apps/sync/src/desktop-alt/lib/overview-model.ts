/**
 * Overview board pure model helpers (US-004, V2 design).
 *
 * Checks-passing formula (per hq-desktop-v2/references.md, Feature 2):
 *
 *   checksPassing% = 100 * (count of stories with passes == true)
 *                        / (count of all stories across all projects
 *                           of the active company)
 *
 * Computed desktop-side from local prd.json data — no hq-pro endpoint.
 * When the denominator is 0 (no projects, or unreadable prd.json), the stat
 * is HIDDEN (null) — never rendered as "0%" as if checks were failing.
 */
import type { Project } from './projects-model';
import type { HomeCardModel } from '../v4/home-model';

export interface ChecksPassing {
  passed: number;
  total: number;
  /** 0–100, rounded. */
  percent: number;
}

/**
 * Compute the checks-passing stat from local project story flags.
 * `storiesComplete` on a scanned project is the count of stories with
 * `passes == true`; `storiesTotal` is all stories in that project's prd.json.
 * Returns null when there are no stories at all (stat must be hidden).
 */
export function checksPassing(projects: readonly Project[]): ChecksPassing | null {
  const total = projects.reduce((sum, project) => sum + Math.max(0, project.storiesTotal), 0);
  if (total === 0) return null;
  const passed = projects.reduce(
    (sum, project) => sum + Math.max(0, Math.min(project.storiesComplete, project.storiesTotal)),
    0,
  );
  return {
    passed,
    total,
    percent: Math.max(0, Math.min(100, Math.round((passed / total) * 100))),
  };
}

/**
 * Needs-you card for unresolved sync conflicts. Mirrors the popover's rescue
 * vocabulary (keep local / keep cloud); returns null when nothing is pending.
 */
export function conflictsNeedsYouCard(
  pendingCount: number,
  resolving = false,
): (HomeCardModel & { id: string }) | null {
  if (pendingCount <= 0) return null;
  return {
    id: 'sync-conflicts',
    title:
      pendingCount === 1
        ? '1 sync conflict needs a decision'
        : `${pendingCount} sync conflicts need a decision`,
    sub: 'Local and cloud copies differ — pick which version wins',
    tone: 'warn',
    actions: [
      {
        id: 'keep-local',
        label: resolving ? 'Resolving…' : 'Keep local',
        kind: 'primary',
        disabled: resolving,
      },
      {
        id: 'keep-cloud',
        label: 'Keep cloud',
        kind: 'secondary',
        disabled: resolving,
      },
    ],
  };
}
