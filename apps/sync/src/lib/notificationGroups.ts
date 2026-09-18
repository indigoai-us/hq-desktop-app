/**
 * Shared notification shapes for the surfaces that render them.
 *
 * The day-grouping + cluster-collapse logic that used to live here belonged to
 * the tray popover's notification feed and was deleted with it (PL-07). The
 * desktop window's Inbox has its own grouping in
 * `packages/ui/src/inbox/notification-groups.ts`. What remains are the item
 * shapes every surviving surface shares, plus the automated-notice key the
 * quick-window side pane uses to compact repeated server notices.
 */
import { automatedAgentJoinNoticeKey } from './automatedNotices';

export type Kind = 'dm' | 'share' | 'new-file' | 'update';

export interface DmEvent {
  eventId: string;
  fromPersonUid: string;
  fromEmail: string;
  fromDisplayName: string;
  body: string;
  details?: string | null;
  prompt?: string | null;
  createdAt: string;
}

export interface ShareEvent {
  eventId: string;
  issuerEmail: string;
  issuerDisplayName: string;
  /** Canonical person uid of the issuer (hq-pro US-026); "" on legacy rows
   *  the server can't attribute. Optional so older cached payloads parse. */
  issuerPersonUid?: string;
  paths: string[];
  note: string | null;
  permission: string;
  createdAt: string;
}

export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
  /** Trusted first-detection time supplied by the native updater. */
  detectedAt?: string;
}

export interface Item {
  id: string;
  kind: Kind;
  actor: string;
  summary: string;
  /** Epoch ms for sorting. */
  ts: number;
  dm?: DmEvent;
  share?: ShareEvent;
  /** Structured fields for `new-file` items. */
  file?: { company: string; path: string };
  /** Trusted pending updater state for `update` items. */
  update?: UpdateInfo;
}

/**
 * Return a stable key only for server-shaped automated notices.
 *
 * Exact human DMs (including terse replies such as "OK") deliberately return
 * null so every message stays independently actionable.
 */
export function repeatedAutomatedMessageKey(it: Item): string | null {
  if (it.kind !== 'dm' || !it.dm) return null;
  return automatedAgentJoinNoticeKey({
    kind: it.kind,
    body: it.dm.body || it.summary,
    fromPersonUid: it.dm.fromPersonUid,
    fromEmail: it.dm.fromEmail,
    fromDisplayName: it.dm.fromDisplayName || it.actor,
    details: it.dm.details,
    prompt: it.dm.prompt,
  });
}
