/**
 * Portfolio session helpers shared by channel status and board models.
 *
 * US-015: project matching no longer uses cwd substring heuristics. Local
 * Sessions-app rows are shown only when they carry a server binding.
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
  /**
   * Server session id when this local observation is bound to a work-mesh
   * session (US-015). Absent → do not surface in channel/board live UI.
   */
  serverSessionId?: string | null;
  /** Bound task id from the server when known. */
  taskId?: string | null;
}

/** Minimal project shape needed for session display. */
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

/**
 * Local Sessions-app observations are honest only when the daemon/server has
 * bound them. Cwd / folder-name guesses are never enough (US-015).
 */
export function sessionHasServerBinding(
  session: Pick<PortfolioSessionRef, "serverSessionId">,
): boolean {
  return Boolean((session.serverSessionId ?? "").trim());
}
