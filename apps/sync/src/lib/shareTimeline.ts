/**
 * Pure helpers for surfacing share events inside the Messages experience:
 *
 *   - matching a share to a DM peer (issuerPersonUid preferred, issuerEmail
 *     fallback for legacy rows the server can't attribute),
 *   - merging a peer's shares into their DM thread as inline share-card
 *     bubbles (client-side merge only — the data already arrives via
 *     `fetch_notification_history`),
 *   - the rail "shared a file" preview when a contact's newest item is a
 *     share rather than a DM,
 *   - the templated share prompt (moved verbatim from ShareDetail.svelte so
 *     both surfaces copy the identical text).
 *
 * Pure + side-effect free so it's unit-testable without a DOM.
 */

import type { ShareEvent } from './notificationGroups';
import { shareTitle } from './share-path';

/** The minimum identity needed to match shares to a conversation peer. */
export interface PeerIdentity {
  personUid?: string | null;
  email?: string | null;
}

function normEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** True when `share` was issued by `peer`. The canonical personUid wins when
 * both sides carry one; legacy rows (empty issuerPersonUid) fall back to a
 * case-insensitive email match. */
export function shareMatchesPeer(share: ShareEvent, peer: PeerIdentity): boolean {
  const shareUid = share.issuerPersonUid?.trim() ?? '';
  const peerUid = peer.personUid?.trim() ?? '';
  if (shareUid && peerUid) return shareUid === peerUid;
  const shareEmail = normEmail(share.issuerEmail);
  const peerEmail = normEmail(peer.email);
  return Boolean(shareEmail) && shareEmail === peerEmail;
}

/** All of `peer`'s shares, oldest → newest (thread order). */
export function sharesForPeer(shares: ShareEvent[], peer: PeerIdentity): ShareEvent[] {
  return shares
    .filter((s) => shareMatchesPeer(s, peer))
    .slice()
    .sort((a, b) => parseTs(a.createdAt) - parseTs(b.createdAt));
}

function parseTs(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
}

/** The templated prompt for a share (identical to ShareDetail's Copy prompt /
 * Open in Claude text). */
export function buildSharePrompt(share: ShareEvent): string {
  const pathList = share.paths.join(', ');
  const note = share.note?.trim() || '(no note)';
  return `${share.issuerDisplayName} shared these files with me: ${pathList}\n\nTheir note: ${note}.`;
}

/** Short human summary of a share ("Shared a file: report.md" / "Shared 3
 * files: a, b, c"). Used for the rail preview and the share bubble a11y label. */
export function shareSummary(share: ShareEvent): string {
  const names = share.paths.map((p) => shareTitle(p));
  if (names.length === 1) return `Shared a file: ${names[0]}`;
  return `Shared ${names.length} files: ${names.join(', ')}`;
}

/** The subset of a conversation message the merge needs. */
interface TimelineEntry {
  createdAt: string;
}

/**
 * Merge a peer's share events into their DM thread (both oldest → newest),
 * returning a NEW chronologically ordered list. Shares are converted with
 * `toMessage` (the host builds its own message shape); a share whose timestamp
 * ties a DM's sorts after it (stable).
 */
export function mergeSharesIntoThread<M extends TimelineEntry>(
  messages: M[],
  shares: ShareEvent[],
  toMessage: (share: ShareEvent) => M,
): M[] {
  if (shares.length === 0) return messages;
  const merged = [...messages, ...shares.map(toMessage)];
  // Stable sort on timestamp keeps DMs before same-instant shares.
  return merged
    .map((m, i) => [m, i] as const)
    .sort((a, b) => parseTs(a[0].createdAt) - parseTs(b[0].createdAt) || a[1] - b[1])
    .map(([m]) => m);
}

/** The contact-preview subset the share preview updates. */
export interface SharePreviewFields extends PeerIdentity {
  previewBody?: string | null;
  previewAt?: string | null;
  previewDirection?: string | null;
  lastMessageAt?: string | null;
}

/**
 * True when a contact rail preview is the projection of this exact share.
 * The unified Messages rail renders the share as its own notification row, so
 * callers can suppress the duplicate contact row while preserving a newer DM.
 */
export function previewRepresentsShare(
  contact: SharePreviewFields,
  share: ShareEvent,
): boolean {
  const previewAt = parseTs(contact.previewAt ?? contact.lastMessageAt);
  return (
    previewAt > 0 &&
    previewAt === parseTs(share.createdAt) &&
    contact.previewBody === shareSummary(share)
  );
}

/**
 * Overlay "shared a file" previews onto the contact rail: for each contact
 * whose NEWEST matching share is more recent than their current preview, set
 * the preview to the share summary. Returns a NEW array (inputs untouched);
 * contacts without a newer share pass through unchanged.
 */
export function applySharePreviews<C extends SharePreviewFields>(
  contacts: C[],
  shares: ShareEvent[],
): C[] {
  if (shares.length === 0) return contacts;
  return contacts.map((c) => {
    const newest = sharesForPeer(shares, c).at(-1);
    if (!newest) return c;
    const shareTs = parseTs(newest.createdAt);
    const previewTs = Math.max(parseTs(c.previewAt), parseTs(c.lastMessageAt));
    if (shareTs <= previewTs) return c;
    return {
      ...c,
      previewBody: shareSummary(newest),
      previewAt: newest.createdAt,
      previewDirection: 'in',
      lastMessageAt: newest.createdAt,
    };
  });
}
