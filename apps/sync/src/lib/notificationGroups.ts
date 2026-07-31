/**
 * Grouping + collapse logic for notification surfaces.
 *
 * A single sync run can pull down dozens of files, each of which would otherwise
 * render as its own "New file in {company}: {path}" row — burying the genuinely
 * distinct notifications (DMs, shares). This module partitions notifications into
 * day groups (Today / Yesterday / date) and, within each day, collapses
 * **new-file** items by company into a single cluster row. Automated membership
 * DMs with identical copy are also compacted: these are server-generated notices
 * (for example, a burst of "A new agent … joined" messages), not human replies.
 * Ordinary DMs and shares remain individual rows.
 *
 * Pure + side-effect free so it's unit-testable: callers inject `now` rather than
 * reading the clock here.
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
  /** Epoch ms for sorting + day grouping. */
  ts: number;
  dm?: DmEvent;
  share?: ShareEvent;
  /** Structured fields for `new-file` items, used to key the collapse. */
  file?: { company: string; path: string };
  /** Trusted pending updater state for `update` items. */
  update?: UpdateInfo;
}

/** A rendered row: either a standalone notification or a compact cluster. */
export type Row =
  | { type: 'single'; item: Item }
  | {
      type: 'cluster';
      clusterKind: 'new-file' | 'repeated-message';
      key: string;
      company: string;
      actor: string;
      actors: string[];
      summary: string;
      count: number;
      latestTs: number;
      items: Item[];
    };

export interface DayGroup {
  key: string;
  label: string;
  rows: Row[];
}

/** Stable day bucket key (local calendar day). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Human day label: Today / Yesterday / "Mon D" (with year when not the current year). */
export function dayLabel(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const yest = new Date(now);
  yest.setDate(today.getDate() - 1);
  if (dayKey(ms) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ms) === dayKey(yest.getTime())) return 'Yesterday';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    }).format(d);
  } catch {
    return '';
  }
}

export interface NotificationGroupingOptions {
  /**
   * Flat surfaces such as Inbox can aggregate repeated automated messages over
   * the complete retained timeline. Day-labelled feeds keep one aggregate per
   * day so their chronology remains literal.
   */
  aggregateRepeatedMessagesAcrossDays?: boolean;
}

/** Company activity is more legible as one roll-up, even when several people contributed. */
function newFileClusterKey(it: Item): string {
  return it.file?.company ?? '';
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

function appendToCluster(
  cluster: Extract<Row, { type: 'cluster' }>,
  item: Item,
): void {
  cluster.items.push(item);
  cluster.count += 1;
  if (item.ts > cluster.latestTs) cluster.latestTs = item.ts;
  if (item.actor && !cluster.actors.includes(item.actor)) {
    cluster.actors.push(item.actor);
  }
}

/**
 * Partition `items` (expected newest-first) into day groups, collapsing new-file
 * items within each day by company and repeated automated membership messages by
 * identical normalized copy. A cluster of one is demoted back to a `single` row
 * so a lone event looks exactly as it did before.
 *
 * A cluster row is positioned at the spot of its newest member, so chronological
 * order across DMs/shares/clusters is preserved.
 */
export function buildNotificationGroups(
  items: Item[],
  now: number = Date.now(),
  options: NotificationGroupingOptions = {},
): DayGroup[] {
  const groups: DayGroup[] = [];
  let curKey: string | null = null;
  let curGroup: DayGroup | null = null;
  // File rows remain day-local. Repeated automated messages may span day
  // boundaries on flat, non-day-labelled surfaces such as Inbox.
  let fileClusters = new Map<string, Extract<Row, { type: 'cluster' }>>();
  let repeatedMessageClusters = new Map<string, Extract<Row, { type: 'cluster' }>>();

  for (const it of items) {
    const k = dayKey(it.ts);
    if (!curGroup || curKey !== k) {
      curKey = k;
      curGroup = { key: k, label: dayLabel(it.ts, now), rows: [] };
      groups.push(curGroup);
      fileClusters = new Map();
      if (!options.aggregateRepeatedMessagesAcrossDays) {
        repeatedMessageClusters = new Map();
      }
    }

    if (it.kind === 'new-file') {
      const ck = newFileClusterKey(it);
      const existing = fileClusters.get(ck);
      if (existing) {
        appendToCluster(existing, it);
      } else {
        const cluster: Extract<Row, { type: 'cluster' }> = {
          type: 'cluster',
          clusterKind: 'new-file',
          key: `${curKey}::${ck}`,
          company: it.file?.company ?? '',
          actor: it.actor,
          actors: it.actor ? [it.actor] : [],
          summary: it.summary,
          count: 1,
          latestTs: it.ts,
          items: [it],
        };
        fileClusters.set(ck, cluster);
        curGroup.rows.push(cluster);
      }
      continue;
    }

    const repeatedKey = repeatedAutomatedMessageKey(it);
    if (repeatedKey) {
      const existing = repeatedMessageClusters.get(repeatedKey);
      if (existing) {
        appendToCluster(existing, it);
      } else {
        const cluster: Extract<Row, { type: 'cluster' }> = {
          type: 'cluster',
          clusterKind: 'repeated-message',
          key: `repeat:${options.aggregateRepeatedMessagesAcrossDays ? 'all' : curKey}::${repeatedKey}`,
          company: '',
          actor: it.actor,
          actors: it.actor ? [it.actor] : [],
          summary: it.summary,
          count: 1,
          latestTs: it.ts,
          items: [it],
        };
        repeatedMessageClusters.set(repeatedKey, cluster);
        curGroup.rows.push(cluster);
      }
    } else {
      curGroup.rows.push({ type: 'single', item: it });
    }
  }

  // Demote singleton clusters back to plain rows.
  for (const group of groups) {
    group.rows = group.rows.map((row) =>
      row.type === 'cluster' && row.count === 1
        ? ({ type: 'single', item: row.items[0] } as Row)
        : row,
    );
  }

  return groups;
}
