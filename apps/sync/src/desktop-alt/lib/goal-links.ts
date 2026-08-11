/**
 * Goal ↔ project association helper (US-005) — the SINGLE matcher both the
 * Goals page and the Overview rollup read.
 *
 * The durable association lives in the goal's own store: an objective's
 * `initiativeIds` in the company `board.json` (vault-synced). A project is
 * "linked" to a goal when any of its identity tokens (id, name, title, prd
 * directory name) matches any of the objective's link ids after tolerant
 * normalization. `goalLinkRef` is the canonical token new links write.
 */
import type { Objective } from './local-projects';
import type { Project } from './projects-model';

/** Tolerant id normalization: lowercase, alphanumerics only. */
export function normalizeGoalLinkId(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Every id an objective can be linked through (initiative + linear + own id). */
export function objectiveLinkIds(objective: Objective): Set<string> {
  const ids = new Set<string>();
  for (const id of objective.initiativeIds ?? []) {
    const normalized = normalizeGoalLinkId(id);
    if (normalized) ids.add(normalized);
  }
  const linearId = normalizeGoalLinkId(objective.linearInitiativeId);
  if (linearId) ids.add(linearId);
  const ownId = normalizeGoalLinkId(objective.id);
  if (ownId) ids.add(ownId);
  return ids;
}

/** Every identity token a project can be matched by. */
export function projectLinkTokens(project: Project): string[] {
  return [
    project.id,
    project.name,
    project.title,
    project.prdPath.split('/').filter(Boolean).at(-2),
  ]
    .map(normalizeGoalLinkId)
    .filter(Boolean);
}

/** Whether one project is linked to one objective. */
export function isProjectLinkedToGoal(objective: Objective, project: Project): boolean {
  const ids = objectiveLinkIds(objective);
  if (ids.size === 0) return false;
  return projectLinkTokens(project).some((token) => ids.has(token));
}

/**
 * The projects (from an already company-scoped list) linked to one objective —
 * the same association the Overview rollup reads.
 */
export function goalLinkedProjects(objective: Objective, projects: Project[]): Project[] {
  const ids = objectiveLinkIds(objective);
  if (ids.size === 0) return [];
  return projects.filter((project) =>
    projectLinkTokens(project).some((token) => ids.has(token)),
  );
}

/**
 * The canonical durable token a new link writes into the goal's
 * `initiativeIds`: the project's stable id, falling back to the prd directory
 * name. Never a path.
 */
export function goalLinkRef(project: Project): string {
  const dirName = project.prdPath.split('/').filter(Boolean).at(-2) ?? '';
  const ref = (project.id || dirName || project.name || project.title || '').trim();
  return ref.split('/').filter(Boolean).at(-1) ?? '';
}
