/**
 * "Share to channel" — the pure half of the dialog.
 *
 * Everything here is data in, data out: the draft the dialog edits, the exact
 * payload `session_share_to_channel` takes, the preview line the operator
 * reads before confirming, and the folding of the per-invite results the
 * backend returns. The dialog owns the DOM and the one confirm click; the
 * live-session store owns the mutating invoke. This module owns neither, so
 * every rule about names, slugs and wording is testable without a mount.
 *
 * The two READ-ONLY commands the dialog needs to populate itself —
 * `hq_share_to_channel_preflight` and `hq_company_projects` — are wrapped here
 * because they are HQ-context reads, not session commands; the store stays
 * the one place `agent_session_*` and `session_*` are spoken.
 */
import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One channel the preflight offers (Rust `PreflightChannel`). */
export interface PreflightChannel {
  channelId: string;
  name: string;
  /** `personal` | `company` | `group` | `project`. */
  kind: string;
}

/** One person or fleet agent the preflight offers (Rust `PreflightMember`). */
export interface PreflightMember {
  uid: string;
  displayName: string;
  /** `human` | `agent`. */
  kind: string;
}

/** `hq_share_to_channel_preflight` → the channels and members to pick from. */
export interface SharePreflight {
  channels: PreflightChannel[];
  members: PreflightMember[];
}

/** One of a company's projects (Rust `ProjectEntry`). */
export interface CompanyProject {
  name: string;
  description: string;
  branchName: string | null;
  path: string;
  storyCounts: { total: number; done: number };
  updatedAt: string | null;
}

/** Where the share lands: a channel that exists, or one to create. */
export type ShareTarget =
  | { kind: 'existing'; channelId: string }
  | { kind: 'new'; name: string; projectPath?: string };

/** The exact argument shape of `session_share_to_channel`. */
export interface ShareToChannelRequest {
  sessionId: string;
  company: string;
  target: ShareTarget;
  inviteUids: string[];
  includeTranscript: boolean;
  note?: string;
}

/** One invite's outcome, as the backend reports it. */
export interface InviteOutcome {
  uid: string;
  ok: boolean;
  error?: string;
}

/** What `session_share_to_channel` returns. */
export interface ShareToChannelResult {
  channelId: string;
  channelName: string;
  created: boolean;
  invited: InviteOutcome[];
  postedEventId?: string;
  digestChars: number;
}

// ---------------------------------------------------------------------------
// Read-only loads
// ---------------------------------------------------------------------------

/** The channels + members a session could be shared with. Read-only. */
export function loadSharePreflight(company: string): Promise<SharePreflight> {
  return invoke<SharePreflight>('hq_share_to_channel_preflight', { company });
}

/** A company's projects, for the "new channel from project" picker. */
export function loadCompanyProjects(company: string): Promise<CompanyProject[]> {
  return invoke<CompanyProject[]>('hq_company_projects', { company });
}

// ---------------------------------------------------------------------------
// The draft the dialog edits
// ---------------------------------------------------------------------------

export interface ShareDraft {
  sessionId: string;
  company: string | null;
  targetKind: 'existing' | 'new';
  /** The picked existing channel, when `targetKind === 'existing'`. */
  channelId: string | null;
  /** The typed name for a new channel (with or without a leading `#`). */
  newName: string;
  /** The project a new channel is being made from, if any. */
  projectPath: string | null;
  inviteUids: string[];
  includeTranscript: boolean;
  note: string;
}

export function emptyShareDraft(sessionId: string, company: string | null): ShareDraft {
  return {
    sessionId,
    company,
    targetKind: 'existing',
    channelId: null,
    newName: '',
    projectPath: null,
    inviteUids: [],
    includeTranscript: true,
    note: '',
  };
}

/**
 * A channel-safe slug: lowercase, `a-z0-9-_`, runs of anything else collapsed
 * to one dash, no leading `#` and no dangling dashes. Empty in → empty out.
 */
export function channelSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The `#p-<slug>` name a project's channel is prefilled with (no `#`). */
export function projectChannelName(project: Pick<CompanyProject, 'name' | 'path'>): string {
  const base = channelSlug(project.name) || channelSlug(lastSegment(project.path));
  return base ? `p-${base}` : '';
}

function lastSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** `#name` for display; the backend and the payload never see the `#`. */
export function hashName(name: string): string {
  const bare = name.replace(/^#+/, '');
  return bare ? `#${bare}` : '';
}

/**
 * The one reason the Share button is still off, or `''` when the draft can
 * be sent. Ordered so the operator is told the FIRST thing to fix.
 */
export function shareDraftBlocker(draft: ShareDraft): string {
  if (!draft.sessionId) return 'No live session to share.';
  if (!draft.company) return 'Bind this session to a company first.';
  if (draft.targetKind === 'existing') {
    return draft.channelId ? '' : 'Pick a channel.';
  }
  return channelSlug(draft.newName) ? '' : 'Name the new channel.';
}

/**
 * The exact `session_share_to_channel` arguments for a draft, or `null` when
 * the draft cannot be sent (see `shareDraftBlocker`). The note is omitted —
 * not sent as `''` — when blank, and invite uids are deduped in pick order.
 */
export function buildSharePayload(draft: ShareDraft): ShareToChannelRequest | null {
  if (shareDraftBlocker(draft)) return null;
  const target: ShareTarget =
    draft.targetKind === 'existing'
      ? { kind: 'existing', channelId: draft.channelId! }
      : {
          kind: 'new',
          name: channelSlug(draft.newName),
          ...(draft.projectPath ? { projectPath: draft.projectPath } : {}),
        };
  const note = draft.note.trim();
  return {
    sessionId: draft.sessionId,
    company: draft.company!,
    target,
    inviteUids: Array.from(new Set(draft.inviteUids)),
    includeTranscript: draft.includeTranscript,
    ...(note ? { note } : {}),
  };
}

/** "2 people" / "1 person" / "1 person and 1 agent" — for the preview line. */
export function inviteSummary(
  uids: ReadonlyArray<string>,
  members: ReadonlyArray<PreflightMember>,
): string {
  const picked = new Set(uids);
  let humans = 0;
  let agents = 0;
  for (const member of members) {
    if (!picked.has(member.uid)) continue;
    if (member.kind === 'agent') agents += 1;
    else humans += 1;
  }
  // A uid the preflight did not list still counts as an invite.
  const unknown = uids.filter((uid) => !members.some((member) => member.uid === uid)).length;
  humans += unknown;
  const parts: string[] = [];
  if (humans > 0) parts.push(`${humans} ${humans === 1 ? 'person' : 'people'}`);
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
  return parts.join(' and ');
}

/**
 * The line above the Share button: what WILL happen, in the operator's words.
 *
 *   "Will post to #general and invite 2 people"
 *   "Will create #p-launch and invite 1 person and 1 agent"
 *   "Will post a note to #general" (transcript digest off)
 */
export function sharePreviewText(
  draft: ShareDraft,
  channels: ReadonlyArray<PreflightChannel>,
  members: ReadonlyArray<PreflightMember>,
): string {
  const blocker = shareDraftBlocker(draft);
  if (blocker) return blocker;
  const verb = draft.includeTranscript ? 'post to' : 'post a note to';
  let head: string;
  if (draft.targetKind === 'existing') {
    const channel = channels.find((item) => item.channelId === draft.channelId);
    head = `Will ${verb} ${hashName(channel?.name ?? draft.channelId ?? '')}`;
  } else {
    head = `Will create ${hashName(channelSlug(draft.newName))}`;
    if (!draft.includeTranscript) head += ' and post a note';
  }
  const invites = inviteSummary(draft.inviteUids, members);
  return invites ? `${head} and invite ${invites}` : head;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface FoldedInvites {
  ok: number;
  failed: { uid: string; error: string }[];
}

/** Count the invites that landed and name the ones that did not. */
export function foldInviteResults(invited: ReadonlyArray<InviteOutcome>): FoldedInvites {
  const folded: FoldedInvites = { ok: 0, failed: [] };
  for (const outcome of invited) {
    if (outcome.ok) folded.ok += 1;
    else folded.failed.push({ uid: outcome.uid, error: outcome.error?.trim() || 'invite failed' });
  }
  return folded;
}

/**
 * "Shared to #name · 2 invited" — the inline result line, minus the "open
 * channel" link the dialog appends as an action. Failures are counted here
 * and listed per uid by the dialog.
 */
export function shareResultText(result: ShareToChannelResult): string {
  const invites = foldInviteResults(result.invited);
  const parts = [`${result.created ? 'Created and shared to' : 'Shared to'} ${hashName(result.channelName)}`];
  if (invites.ok > 0) parts.push(`${invites.ok} invited`);
  if (invites.failed.length > 0) {
    parts.push(`${invites.failed.length} ${invites.failed.length === 1 ? 'invite' : 'invites'} failed`);
  }
  return parts.join(' · ');
}

/** A member's name for a chip or a failure line, falling back to the uid. */
export function memberLabel(uid: string, members: ReadonlyArray<PreflightMember>): string {
  return members.find((member) => member.uid === uid)?.displayName || uid;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query.trim().toLowerCase());
}

/** Channels whose name contains the query (case-insensitive); all when blank. */
export function filterChannels(
  channels: ReadonlyArray<PreflightChannel>,
  query: string,
): PreflightChannel[] {
  const needle = query.trim().replace(/^#+/, '');
  if (!needle) return [...channels];
  return channels.filter((channel) => matches(channel.name, needle));
}

/** Members not yet picked whose name or uid contains the query. */
export function filterMembers(
  members: ReadonlyArray<PreflightMember>,
  query: string,
  excludeUids: ReadonlyArray<string> = [],
): PreflightMember[] {
  const excluded = new Set(excludeUids);
  const needle = query.trim();
  return members.filter(
    (member) =>
      !excluded.has(member.uid) &&
      (!needle || matches(member.displayName, needle) || matches(member.uid, needle)),
  );
}
