/**
 * Paused-upload notices as rows in the shared notifications feed.
 *
 * A plan limit that pauses a company's uploads used to render a banner in the
 * desktop shell, one per company, stacked. A person in a dozen paused
 * companies got a dozen overlapping banners. The notice now goes through the
 * same session-local notification path that channel wakes use: one row per
 * company per paused episode, listed in the notifications panel next to DMs
 * and shares, with the upgrade link as the row's click-through.
 *
 * An episode starts when a company enters the paused set and ends when the
 * native snapshot no longer lists it. A refresh of the same set, a repeated
 * `sync:plan-limit` event, or a reopened window does not add a second row,
 * because the rows (and which episodes are still open) persist per account.
 */

export const PLAN_LIMIT_NOTIFICATION_TYPE = 'plan_limit';
export const PLAN_LIMIT_ID_PREFIX = 'local:plan-limit:';
/** Rows kept in history. Old ended episodes fall off first. */
export const PLAN_LIMIT_HISTORY_CAP = 100;
const STORAGE_PREFIX = 'hq.desktop.planLimitNotifications.v1:';

export interface PlanLimitNotificationRow {
  /** Feed rows are plain records; the feed reads the fields it knows. */
  [key: string]: unknown;
  id: string;
  type: typeof PLAN_LIMIT_NOTIFICATION_TYPE;
  status: 'unread' | 'read';
  createdAt: string;
  actorName: string;
  title: string;
  body: string;
  context: string;
  /** Approved, attributed upgrade link; null when hq-pro returned none. */
  targetRef: string | null;
  company: string;
  companyUid: string | null;
  exposureId: string;
  /** True once plan_limit_prompt_exposed was sent for this row. */
  exposed: boolean;
  /** True while the company is still paused (the episode is open). */
  active: boolean;
}

export interface PlanLimitPause {
  company: string;
  companyUid: string | null;
  upgradeUrl: string | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function planLimitNotificationTitle(company: string): string {
  return `New files are paused for ${company}.`;
}

function rowBody(upgradeUrl: string | null): string {
  return upgradeUrl
    ? 'This company reached its plan limit. Open to upgrade the plan.'
    : 'This company reached its plan limit.';
}

function newRow(pause: PlanLimitPause, now: number, nonce: string): PlanLimitNotificationRow {
  const title = planLimitNotificationTitle(pause.company);
  const body = rowBody(pause.upgradeUrl);
  return {
    id: `${PLAN_LIMIT_ID_PREFIX}${encodeURIComponent(pause.company)}:${now}-${nonce}`,
    type: PLAN_LIMIT_NOTIFICATION_TYPE,
    status: 'unread',
    createdAt: new Date(now).toISOString(),
    actorName: 'HQ',
    title,
    body,
    context: body,
    targetRef: pause.upgradeUrl,
    company: pause.company,
    companyUid: pause.companyUid,
    exposureId: `exposure:${nonce}`,
    exposed: false,
    active: true,
  };
}

export function isPlanLimitNotificationId(id: string): boolean {
  return id.startsWith(PLAN_LIMIT_ID_PREFIX);
}

/**
 * Open an episode for every pause that has none. A company with an open
 * episode keeps its row; only a changed upgrade link or a newly resolved
 * company uid is written onto it. Returns the rows created by this call.
 */
export function recordPlanLimitPauses(
  rows: readonly PlanLimitNotificationRow[],
  pauses: readonly PlanLimitPause[],
  now: number = Date.now(),
  nonce: () => string = () => crypto.randomUUID(),
): { rows: PlanLimitNotificationRow[]; created: PlanLimitNotificationRow[] } {
  let next = [...rows];
  const created: PlanLimitNotificationRow[] = [];
  const seen = new Set<string>();
  for (const pause of pauses) {
    const company = pause.company.trim();
    if (!company || seen.has(company)) continue;
    seen.add(company);
    const index = next.findIndex((row) => row.active && row.company === company);
    if (index >= 0) {
      const current = next[index];
      const upgradeUrl = pause.upgradeUrl ?? current.targetRef;
      const companyUid = current.companyUid ?? pause.companyUid;
      if (upgradeUrl !== current.targetRef || companyUid !== current.companyUid) {
        next[index] = {
          ...current,
          targetRef: upgradeUrl,
          companyUid,
          body: rowBody(upgradeUrl),
          context: rowBody(upgradeUrl),
        };
      }
      continue;
    }
    const row = newRow({ ...pause, company }, now, nonce());
    created.push(row);
    next = [row, ...next];
  }
  if (next.length > PLAN_LIMIT_HISTORY_CAP) {
    const keep = new Set(
      [...next]
        .sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, PLAN_LIMIT_HISTORY_CAP)
        .map((row) => row.id),
    );
    next = next.filter((row) => keep.has(row.id));
  }
  return { rows: next, created };
}

/** Close the open episode of each listed company. Rows stay in history. */
export function endPlanLimitPauses(
  rows: readonly PlanLimitNotificationRow[],
  companies: Iterable<string>,
): PlanLimitNotificationRow[] {
  const ended = new Set([...companies].map((company) => company.trim()));
  if (ended.size === 0) return [...rows];
  return rows.map((row) => (row.active && ended.has(row.company) ? { ...row, active: false } : row));
}

export function markPlanLimitNotificationRead(
  rows: readonly PlanLimitNotificationRow[],
  id: string,
): PlanLimitNotificationRow[] {
  return rows.map((row) => (row.id === id && row.status !== 'read' ? { ...row, status: 'read' } : row));
}

export function markAllPlanLimitNotificationsRead(
  rows: readonly PlanLimitNotificationRow[],
): PlanLimitNotificationRow[] {
  return rows.map((row) => (row.status === 'read' ? row : { ...row, status: 'read' }));
}

/** Fill company uids that the roster resolved after the row was recorded. */
export function resolvePlanLimitCompanyUids(
  rows: readonly PlanLimitNotificationRow[],
  resolve: (company: string) => string | null,
): PlanLimitNotificationRow[] {
  return rows.map((row) => {
    if (row.companyUid) return row;
    const companyUid = resolve(row.company);
    return companyUid ? { ...row, companyUid } : row;
  });
}

/** Plain native banner copy for the pauses one pass opened. */
export function planLimitNativeBanner(
  created: readonly PlanLimitNotificationRow[],
): { title: string; body: string } | null {
  if (created.length === 0) return null;
  if (created.length === 1) {
    return { title: planLimitNotificationTitle(created[0].company), body: 'Open HQ to upgrade the plan.' };
  }
  return {
    title: `New files are paused for ${created.length} companies.`,
    body: 'Open HQ notifications to see which ones and upgrade.',
  };
}

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId}`;
}

function isRow(value: unknown): value is PlanLimitNotificationRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    isPlanLimitNotificationId(row.id) &&
    row.type === PLAN_LIMIT_NOTIFICATION_TYPE &&
    typeof row.company === 'string' &&
    typeof row.createdAt === 'string' &&
    (row.status === 'read' || row.status === 'unread') &&
    typeof row.active === 'boolean'
  );
}

export function loadPlanLimitNotifications(
  storage: StorageLike | null,
  accountId: string | null,
): PlanLimitNotificationRow[] {
  if (!storage || !accountId) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(accountId));
  } catch (error) {
    console.error('Could not read stored plan-limit notifications.', error);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRow) : [];
  } catch (error) {
    console.error('Stored plan-limit notifications are not valid JSON.', error);
    return [];
  }
}

export function savePlanLimitNotifications(
  storage: StorageLike | null,
  accountId: string | null,
  rows: readonly PlanLimitNotificationRow[],
): void {
  if (!storage || !accountId) return;
  try {
    storage.setItem(storageKey(accountId), JSON.stringify(rows));
  } catch (error) {
    console.error('Could not store plan-limit notifications.', error);
  }
}

/**
 * Whether the OS banner may show, read from the same server-backed prefs the
 * other notification kinds honour: an active pause silences it, and so does
 * turning off "Files shared", the nearest existing toggle (uploads are files).
 * In-app rows are history and always record, like DMs and shares do.
 */
export function planLimitBannerAllowed(
  prefs: { pausedUntil?: string | null; files?: boolean } | null,
  now: number = Date.now(),
): boolean {
  if (!prefs) return true;
  const until = prefs.pausedUntil;
  if (until === 'forever') return false;
  if (until) {
    const ts = Date.parse(until);
    if (Number.isFinite(ts) && ts > now) return false;
  }
  return prefs.files !== false;
}
