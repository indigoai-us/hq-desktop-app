/**
 * Inbox merged-feed V2 routing glue (hq-desktop-v2 US-012).
 *
 * The desktop Inbox replaces the separate quick windows (DmDetail /
 * ShareDetail / company Activity window) as the primary notification surface:
 * rows resolve to IN-SHELL destinations instead. Pure route mapping lives
 * here so it is unit-testable without a webview.
 *
 *  - DM rows        → the Messages conversation workspace (the caller stashes
 *                     the conversation target via lib/pendingConversation).
 *  - Share rows     → Files mode, previewing the shared path when the share
 *                     names a single concrete file, else the Files root.
 *  - Workspace rows → the relevant company screen (Activity under More).
 */

import type { DmEvent, ShareEvent } from '../../lib/notificationGroups';
import type { ConversationTarget } from '../../lib/pendingConversation';
import type { DesktopRoute } from '../route';

/** Matches a trailing `/*`, `/**`, or a bare `*`/`**` (mirrors lib/share-path). */
const WILDCARD_SUFFIX = /\/?\*\*?$/;

/**
 * In-shell destination for a share notification: Files mode focused on the
 * shared path. Wildcard (directory / whole-vault) shares drop the wildcard
 * segment and land on the containing directory path when one remains, else
 * the Files root. The DesktopApp files-route guard stays the fail-closed
 * authority — an inaccessible path simply degrades to the Files root there.
 */
export function shareFilesRoute(share: Pick<ShareEvent, 'paths'>): DesktopRoute {
  const first = share.paths.find((p) => p && p.trim().length > 0)?.trim();
  if (!first) return { kind: 'files' };
  const cleaned = first.replace(WILDCARD_SUFFIX, '').replace(/\/+$/, '').trim();
  if (!cleaned || cleaned === '*' || cleaned === '**') return { kind: 'files' };
  return { kind: 'files', path: cleaned };
}

/** In-shell destination for a workspace-activity notification. */
export function workspaceActivityRoute(company: string): DesktopRoute {
  const slug = company.trim();
  if (!slug) return { kind: 'inbox' };
  return { kind: 'company', slug, tab: 'activity' };
}

/** Conversation target for a DM row — consumed by the Messages shell. */
export function dmConversationTarget(
  dm: Pick<DmEvent, 'fromPersonUid' | 'fromEmail' | 'fromDisplayName'>,
): ConversationTarget {
  return {
    personUid: dm.fromPersonUid?.trim() ?? '',
    email: dm.fromEmail?.trim() ?? '',
    displayName: dm.fromDisplayName?.trim() ?? '',
  };
}
