/**
 * The channel status model behind the member pill and the project presence
 * dot. Every source is passed in, so this reads no component state directly.
 * The shell passes getters, so a source is only read (and tracked by the
 * enclosing `$derived`) when the calculation reaches it.
 */
import type { ChannelStatusModel } from "../../chat/channel-status-model.js";
import { buildChannelStatusModel } from "../../chat/channel-status-model.js";
import type { liveInputsForCompanyProject } from "../../chat/live-read-store.svelte.js";
import type { ConversationRow } from "../../chat/sidebar-model.js";
import { companyDisplayName, companyIconUrl } from "../../company/company-display-map.js";
import { projectIdForRow, rosterStatusForRow } from "../live-channel-tabs.js";
import {
  applyAuthoritativePresence,
  applyChannelRoster,
  type parseChannelMembers,
} from "../mesh-overlay.js";

/** One channel's parsed member roster. */
export type ChannelRoster = ReturnType<typeof parseChannelMembers>;

export interface ChannelPresenceSources {
  /** Parsed member rosters by channel id. */
  readonly channelRosterById: Readonly<Record<string, ChannelRoster>>;
  /** Live-read sessions and presence for a company project. */
  readonly liveInputsFor: typeof liveInputsForCompanyProject;
  /** The presence store's status for an actor in a company. */
  readonly presenceStatus: (companyUid: string, actorUid: string) => string | null;
}

export interface ChannelStatusSources extends ChannelPresenceSources {
  /** Host-injected status model for a row (`channelStatusByRow` prop). */
  readonly hostStatus: ((row: ConversationRow) => ChannelStatusModel | null) | undefined;
  /** Status from the live channel tabs load for the open row. */
  readonly liveTabsStatus: ChannelStatusModel | null | undefined;
  readonly companyNames: Map<string, string>;
  readonly companyIcons: Map<string, string>;
  /** person/agent uid → display name for naming roster members. */
  readonly identities: Readonly<Record<string, string>> | null | undefined;
}

/** Sidebar presence dot: only when a project channel has a known online actor. */
export function projectRowHasPresence(
  row: ConversationRow,
  sources: ChannelPresenceSources,
): boolean {
  if (row.kind !== "channel") return false;
  const isProject =
    (row.channelScope ?? "").trim() === "project" ||
    Boolean((row.projectId ?? "").trim());
  if (!isProject) return false;
  const companyUid = (row.companyUid ?? "").trim();
  if (!companyUid) return false;
  const projectId = (row.projectId ?? "").trim() || projectIdForRow(row);
  const live = sources.liveInputsFor(companyUid, projectId);
  // Prefer live-read actors on this project; fall back to channel roster.
  const fromLive = live.liveSessions
    .map((s) => s.actorUid)
    .filter(Boolean);
  if (fromLive.length > 0) {
    return fromLive.some(
      (uid) => sources.presenceStatus(companyUid, uid) === "online",
    );
  }
  const channelId = row.channelId?.trim() ?? "";
  const roster = sources.channelRosterById[channelId] ?? [];
  const actorUids =
    roster.length > 0
      ? roster.map((m) => m.personUid)
      : (row.members ?? []).map((m) => m.personUid);
  if (actorUids.length === 0) {
    // Company-wide online on any presence entry for transparent companies is
    // not enough — without project actors we stay dark (fail closed).
    return false;
  }
  return actorUids.some(
    (uid) => sources.presenceStatus(companyUid, uid) === "online",
  );
}

/** The status model for the open conversation row, or null when it has none. */
export function selectedChannelStatus(
  selectedRow: ConversationRow | null,
  sources: ChannelStatusSources,
): ChannelStatusModel | null {
  if (!selectedRow) return null;
  const channelId = selectedRow.channelId?.trim() ?? "";
  const roster = sources.channelRosterById[channelId] ?? [];
  const companyUid = (selectedRow.companyUid ?? "").trim();
  const projectId = (selectedRow.projectId ?? "").trim() || projectIdForRow(selectedRow);
  const live = sources.liveInputsFor(companyUid, projectId);
  const hostStatus = sources.hostStatus;
  const base =
    hostStatus?.(selectedRow) ??
    sources.liveTabsStatus ??
    (roster.length > 0
      ? rosterStatusForRow(
          selectedRow,
          roster,
          companyUid
            ? companyDisplayName(companyUid, sources.companyNames)
            : null,
          companyUid ? companyIconUrl(companyUid, sources.companyIcons) : null,
        )
      : null);
  // Prefer rebuilding from live read + presence when we have sessions.
  const fromLive =
    live.liveSessions.length > 0 || live.presence.length > 0
      ? buildChannelStatusModel({
          project: {
            id: projectId || channelId || selectedRow.id,
            title: selectedRow.title,
            company: companyUid || undefined,
            storiesTotal: base?.stories.total,
            storiesComplete: base?.stories.complete,
            description: base?.project.description ?? null,
          },
          prd: base
            ? {
                branchName: base.project.branch,
                repoPath: base.project.repo,
                repos: base.project.repos,
                previewUrl: base.project.previewUrl ?? undefined,
              }
            : null,
          members:
            roster.length > 0
              ? roster
              : [
                  ...((base?.members ?? []).map((m) => ({
                    personUid: m.personUid,
                    displayName: m.displayName,
                    email: m.email ?? undefined,
                    role: m.role ?? undefined,
                    avatarUrl: m.avatarUrl ?? undefined,
                    description: m.description ?? undefined,
                  })) ?? []),
                  ...((base?.agents ?? []).map((a) => ({
                    personUid: a.personUid,
                    displayName: a.displayName,
                    email: a.email ?? undefined,
                    role: a.role ?? undefined,
                    avatarUrl: a.avatarUrl ?? undefined,
                    description: a.description ?? undefined,
                    isAgent: true,
                  })) ?? []),
                ],
          liveSessions: live.liveSessions,
          presence: live.presence,
          companyLabel: base?.companyLabel ?? null,
        })
      : null;
  const merged = fromLive ?? base;
  if (!merged) return null;
  const withRoster =
    roster.length === 0
      ? merged
      : applyChannelRoster(merged, roster, sources.identities);
  // Presence store is the only online source (US-015) — re-apply after roster
  // rebuild so timestamps/sessions never invent connection state.
  const withPresence = (uid: string): boolean =>
    Boolean(companyUid) && sources.presenceStatus(companyUid, uid) === "online";
  return {
    ...applyAuthoritativePresence(withRoster, withPresence),
    activeSessions:
      fromLive?.activeSessions ?? withRoster.activeSessions ?? [],
    liveAgents: fromLive?.liveAgents?.length
      ? fromLive.liveAgents
      : withRoster.liveAgents,
  };
}
