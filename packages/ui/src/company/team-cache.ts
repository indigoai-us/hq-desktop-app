/**
 * In-memory Team read per company slug. Team, Company settings and the shared
 * people display (OWNER-R5) read it; kept dependency-free for the start-up bundle.
 */
import type { TeamTelemetryView } from "./team-telemetry.js";
import type { PendingInvite } from "./team-bots-pages.js";

const teamCache = new Map<string, { view: TeamTelemetryView; invites: PendingInvite[] }>();

export function readTeamCache(slug: string): { view: TeamTelemetryView; invites: PendingInvite[] } | null {
  return teamCache.get(slug) ?? null;
}

export function writeTeamCache(
  slug: string,
  value: { view: TeamTelemetryView; invites: PendingInvite[] },
): void {
  if (slug) teamCache.set(slug, value);
}
