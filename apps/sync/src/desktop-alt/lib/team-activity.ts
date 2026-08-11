/**
 * Team vault activity adapter (US-019) — pure normalization for the Overview
 * recent-activity digest. Works against today's production activity payload
 * (no membersDetail / vaultBytes) and the proposed server extension.
 *
 * Policy (hq-absent-field-never-means-constraining-value): any absent field
 * means NO DATA, never an error. Callers degrade to the existing empty state.
 */

export const TEAM_ACTIVITY_WINDOW_DAYS = 7;

export interface ActivityStats {
  files7: number;
  edits7: number;
  members: number;
  vaultSize: string;
  vaultBytes?: number;
}

export interface ActivityContributor {
  who: string;
  edits: number;
}

export interface ActivityMemberDetail {
  who: string;
  edits: number;
  bytes: number;
}

export interface CompanyActivity {
  stats: ActivityStats;
  sparkline: number[];
  top: ActivityContributor[];
  membersDetail?: ActivityMemberDetail[];
}

export interface TeamMemberRow {
  name: string;
  email: string;
  edits: number;
  meta: string;
}

const emptyStats = (): ActivityStats => ({
  files7: 0,
  edits7: 0,
  members: 0,
  vaultSize: '',
});

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const nonNegativeFinite = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
};

/**
 * Defensive coercion of a raw activity payload.
 * Absent optional fields stay undefined — never invent zeros for vaultBytes
 * or an empty membersDetail array when the server did not send them.
 */
export function normalizeTeamActivity(result: unknown): CompanyActivity {
  const raw =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const statsRaw =
    raw.stats && typeof raw.stats === 'object'
      ? (raw.stats as Record<string, unknown>)
      : {};

  const vaultBytes = nonNegativeFinite(statsRaw.vaultBytes);

  const stats: ActivityStats = {
    files7: numberOrZero(statsRaw.files7),
    edits7: numberOrZero(statsRaw.edits7),
    members: numberOrZero(statsRaw.members),
    vaultSize: typeof statsRaw.vaultSize === 'string' ? statsRaw.vaultSize : '',
  };
  if (vaultBytes !== undefined) {
    stats.vaultBytes = vaultBytes;
  }

  const sparkline = Array.isArray(raw.sparkline)
    ? raw.sparkline.map(numberOrZero)
    : [];

  const top = Array.isArray(raw.top)
    ? raw.top.map((c) => {
        const row = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
        return {
          who: typeof row.who === 'string' ? row.who : '',
          edits: numberOrZero(row.edits),
        };
      })
    : [];

  let membersDetail: ActivityMemberDetail[] | undefined;
  if (Array.isArray(raw.membersDetail)) {
    membersDetail = raw.membersDetail.map((m) => {
      const row = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
      return {
        who: typeof row.who === 'string' ? row.who : '',
        edits: numberOrZero(row.edits),
        bytes: numberOrZero(row.bytes),
      };
    });
  }

  const activity: CompanyActivity = {
    stats,
    sparkline,
    top,
  };
  if (membersDetail !== undefined) {
    activity.membersDetail = membersDetail;
  }
  return activity;
}

/** Format raw byte count for the summary line. 0 / non-finite → ''. */
export function formatVaultBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = 1024 ** 3;
  const mb = 1024 ** 2;
  const kb = 1024;
  if (bytes >= 0.95 * gb) {
    return `${(bytes / gb).toFixed(1)} GB`;
  }
  if (bytes >= mb) {
    return `${Math.round(bytes / mb)} MB`;
  }
  if (bytes >= kb) {
    return `${Math.round(bytes / kb)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

/**
 * Join non-empty summary parts with ' · '.
 * Omits zero numeric parts; prefers vaultBytes formatting over vaultSize.
 */
export function teamActivitySummaryLine(a: CompanyActivity): string {
  const stats = a.stats ?? emptyStats();
  const size =
    stats.vaultBytes !== undefined && stats.vaultBytes !== null
      ? formatVaultBytes(stats.vaultBytes)
      : typeof stats.vaultSize === 'string'
        ? stats.vaultSize
        : '';

  return [
    stats.edits7 > 0 ? `${stats.edits7} edits` : null,
    stats.files7 > 0 ? `${stats.files7} files` : null,
    stats.members > 0 ? `${stats.members} members` : null,
    size || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function teamActivityWindowLabel(windowDays: number): string {
  return `Team vault · last ${windowDays} days`;
}

function displayNameFromWho(who: string): string {
  const trimmed = who.trim();
  if (!trimmed) return 'Unknown';
  if (!trimmed.includes('@')) return trimmed;
  const local = trimmed.slice(0, trimmed.indexOf('@'));
  const name = local
    .split(/[._]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return name || 'Unknown';
}

/**
 * Prefer membersDetail when the server sent a non-empty array; else fall back
 * to top contributors. Absent membersDetail adds no constraint.
 */
export function teamMemberRows(a: CompanyActivity): TeamMemberRow[] {
  const fromDetail =
    Array.isArray(a.membersDetail) && a.membersDetail.length > 0
      ? a.membersDetail.map((m) => ({ who: m.who ?? '', edits: numberOrZero(m.edits) }))
      : null;
  const source =
    fromDetail ??
    (Array.isArray(a.top) ? a.top.map((c) => ({ who: c.who ?? '', edits: numberOrZero(c.edits) })) : []);

  return source
    .filter((row) => !(row.who.trim() === '' && row.edits === 0))
    .map((row) => {
      const who = typeof row.who === 'string' ? row.who : '';
      const edits = numberOrZero(row.edits);
      const isEmail = who.includes('@');
      return {
        name: displayNameFromWho(who),
        email: isEmail ? who : '',
        edits,
        meta: `updated ${edits} ${edits === 1 ? 'file' : 'files'}`,
      };
    });
}

export function hasTeamActivity(a: CompanyActivity): boolean {
  const detailLen = Array.isArray(a.membersDetail) ? a.membersDetail.length : 0;
  const topLen = Array.isArray(a.top) ? a.top.length : 0;
  if (detailLen > 0 || topLen > 0) return true;
  if (Array.isArray(a.sparkline) && a.sparkline.some((v) => v > 0)) return true;
  return (a.stats?.edits7 ?? 0) > 0;
}
