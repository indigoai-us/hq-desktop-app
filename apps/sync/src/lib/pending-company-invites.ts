/**
 * Invites from the "Name your company" step that could not go out because the
 * new company was not provisioned yet.
 *
 * The setup step queues them here; the app sends them the next time it sees
 * the company provisioned (at shell start and after each roster refresh
 * event). The queue lives in this device's localStorage only. An entry is
 * dropped once every invite in it was sent, after MAX_ATTEMPTS server
 * refusals, or after MAX_AGE_MS, and each drop is logged.
 */
import { sendCompanyInvites, type CompanyInvite, type CreateCompanyApi } from '@hq/ui';

export const PENDING_COMPANY_INVITES_KEY = 'hq.pendingCompanyInvites.v1';
export const MAX_ATTEMPTS = 3;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingCompanyInvites {
  companyUid: string;
  invites: CompanyInvite[];
  queuedAt: number;
  attempts: number;
}

export type FlushApi = Pick<CreateCompanyApi, 'runCompanyTabAction' | 'readCompanyProvisioned'>;

export interface FlushReport {
  sent: Array<{ companyUid: string; count: number }>;
  failed: Array<{ companyUid: string; email: string; reason: string }>;
  waiting: string[];
  dropped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): PendingCompanyInvites | null {
  if (!isRecord(value)) return null;
  const { companyUid, invites, queuedAt, attempts } = value;
  if (typeof companyUid !== 'string' || !companyUid.startsWith('cmp_')) return null;
  if (!Array.isArray(invites)) return null;
  const parsed = invites.flatMap((invite) =>
    isRecord(invite) && typeof invite.email === 'string' && invite.email.trim()
      ? [{ email: invite.email.trim(), role: typeof invite.role === 'string' ? invite.role : 'member' }]
      : [],
  );
  if (parsed.length === 0) return null;
  return {
    companyUid,
    invites: parsed,
    queuedAt: typeof queuedAt === 'number' ? queuedAt : 0,
    attempts: typeof attempts === 'number' ? attempts : 0,
  };
}

export function readPendingCompanyInvites(storage: Storage | null): PendingCompanyInvites[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_COMPANY_INVITES_KEY);
  } catch (err) {
    console.warn('pending company invites: could not read the queue', err);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap((entry) => parseEntry(entry) ?? []) : [];
  } catch (err) {
    console.warn('pending company invites: the queue was unreadable and was reset', err);
    return [];
  }
}

function writePendingCompanyInvites(storage: Storage, entries: PendingCompanyInvites[]): void {
  if (entries.length === 0) storage.removeItem(PENDING_COMPANY_INVITES_KEY);
  else storage.setItem(PENDING_COMPANY_INVITES_KEY, JSON.stringify(entries));
}

/** Add invites for a company, merging with any already queued for it. */
export function queuePendingCompanyInvites(
  storage: Storage | null,
  companyUid: string,
  invites: readonly CompanyInvite[],
  now: () => number = Date.now,
): boolean {
  if (!storage || invites.length === 0) return false;
  const entries = readPendingCompanyInvites(storage);
  const existing = entries.find((entry) => entry.companyUid === companyUid);
  if (existing) {
    const known = new Set(existing.invites.map((invite) => invite.email.toLowerCase()));
    for (const invite of invites) {
      if (!known.has(invite.email.toLowerCase())) existing.invites.push({ ...invite });
    }
  } else {
    entries.push({ companyUid, invites: invites.map((invite) => ({ ...invite })), queuedAt: now(), attempts: 0 });
  }
  try {
    writePendingCompanyInvites(storage, entries);
    return true;
  } catch (err) {
    console.error('pending company invites: could not save the queue', err);
    return false;
  }
}

let inFlight: Promise<FlushReport> | null = null;

/**
 * Send queued invites for every company that is now provisioned. Concurrent
 * calls share one pass so an address is never invited twice by this device.
 */
export function flushPendingCompanyInvites(
  storage: Storage | null,
  api: FlushApi,
  now: () => number = Date.now,
): Promise<FlushReport> {
  if (!inFlight) {
    inFlight = runFlush(storage, api, now).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runFlush(storage: Storage | null, api: FlushApi, now: () => number): Promise<FlushReport> {
  const report: FlushReport = { sent: [], failed: [], waiting: [], dropped: [] };
  if (!storage) return report;
  const entries = readPendingCompanyInvites(storage);
  if (entries.length === 0) return report;
  const remaining: PendingCompanyInvites[] = [];
  for (const entry of entries) {
    if (now() - entry.queuedAt > MAX_AGE_MS) {
      console.error('pending company invites: dropped invites that waited too long', {
        companyUid: entry.companyUid,
        count: entry.invites.length,
      });
      report.dropped.push(entry.companyUid);
      continue;
    }
    let ready = false;
    try {
      ready = typeof api.readCompanyProvisioned === 'function' && (await api.readCompanyProvisioned(entry.companyUid));
    } catch (err) {
      console.warn('pending company invites: provisioning status read failed', err);
    }
    if (!ready) {
      report.waiting.push(entry.companyUid);
      remaining.push(entry);
      continue;
    }
    const failures = await sendCompanyInvites(api, entry.companyUid, entry.invites);
    const failedEmails = new Set(failures.map((failure) => failure.email.toLowerCase()));
    const sentCount = entry.invites.length - failures.length;
    if (sentCount > 0) report.sent.push({ companyUid: entry.companyUid, count: sentCount });
    for (const failure of failures) {
      report.failed.push({ companyUid: entry.companyUid, email: failure.email, reason: failure.reason });
    }
    if (failures.length === 0) continue;
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      console.error('pending company invites: dropped invites the server kept refusing', {
        companyUid: entry.companyUid,
        reasons: failures.map((failure) => failure.reason),
      });
      report.dropped.push(entry.companyUid);
      continue;
    }
    console.warn('pending company invites: some invites were refused; will retry', {
      companyUid: entry.companyUid,
      reasons: failures.map((failure) => failure.reason),
    });
    remaining.push({
      ...entry,
      attempts,
      invites: entry.invites.filter((invite) => failedEmails.has(invite.email.trim().toLowerCase())),
    });
  }
  // Re-read so invites queued during this pass are kept.
  const merged = [...remaining];
  for (const latest of readPendingCompanyInvites(storage)) {
    const original = entries.find((entry) => entry.companyUid === latest.companyUid);
    const seen = new Set((original?.invites ?? []).map((invite) => invite.email.toLowerCase()));
    const added = latest.invites.filter((invite) => !seen.has(invite.email.toLowerCase()));
    if (added.length === 0) continue;
    const kept = merged.find((entry) => entry.companyUid === latest.companyUid);
    if (kept) kept.invites.push(...added);
    else merged.push({ ...latest, invites: added });
  }
  try {
    writePendingCompanyInvites(storage, merged);
  } catch (err) {
    console.error('pending company invites: could not save the queue', err);
  }
  return report;
}
