/**
 * Live-session matching helpers extracted from the desktop-alt
 * `lib/projects-model.ts` (only the pieces channel-status-model needs —
 * the full projects model belongs to a later wave).
 */

export interface PortfolioSessionRef {
  project: string;
  company: string;
  cwd: string;
  status: string;
  startedAt?: string;
  lastActivityAt?: string;
  tool?: string;
  model?: string;
  source?: string;
}

/** Minimal project shape needed for session matching. */
export interface ProjectMatchRef {
  id?: string | null;
  name?: string | null;
  title?: string | null;
  prdPath?: string | null;
  company?: string | null;
}

export function isPortfolioLiveStatus(
  status: string | null | undefined,
): boolean {
  const raw = (status ?? "").toLowerCase();
  return raw === "running" || raw === "awaiting_input";
}

function normalizePortfolioToken(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function projectMatchTokens(project: ProjectMatchRef): string[] {
  const fromPath = project.prdPath
    ? project.prdPath.split("/").filter(Boolean).at(-2)
    : undefined;
  return [project.id, project.name, project.title, fromPath]
    .map(normalizePortfolioToken)
    .filter((token) => token.length >= 2);
}

export function sessionMatchesProject(
  session: PortfolioSessionRef,
  project: ProjectMatchRef,
): boolean {
  const sessionCompany = (session.company ?? "").trim().toLowerCase();
  const projectCompany = (project.company ?? "").trim().toLowerCase();
  if (sessionCompany && projectCompany && sessionCompany !== projectCompany) {
    return false;
  }

  const sessionProject = (session.project ?? "").trim().toLowerCase();
  const projectId = (project.id ?? "").trim().toLowerCase();
  // Exact id / display-name match first (handles short project slugs).
  if (sessionProject) {
    if (projectId && sessionProject === projectId) return true;
    const name = (project.name ?? project.title ?? "").trim().toLowerCase();
    if (name && sessionProject === name) return true;
  }

  const tokens = projectMatchTokens(project).filter(
    (token) => token.length >= 2,
  );
  if (tokens.length === 0) return false;

  const hay = normalizePortfolioToken(
    [session.project, session.cwd, session.source ?? ""]
      .filter(Boolean)
      .join(" "),
  );
  if (!hay) return false;
  return tokens.some((token) => hay.includes(token));
}
