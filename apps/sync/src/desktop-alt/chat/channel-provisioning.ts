/**
 * US-021 — project-channel auto-activation + owner listing helpers.
 *
 * Pure/DI module (no Svelte runes) so debounce, dedupe, and absent-safe
 * degrade are unit-testable:
 *
 *  - `createProjectChannelProvisioner` schedules idempotent
 *    `ensure_project_channel` invokes for the user's member projects
 *    (debounced, per-session deduped, silent no-op when the endpoint is
 *    absent — old servers 404 and the Rust command resolves to a Default).
 *  - `collectEnsureTargets` maps local projects (company slug) onto cloud
 *    company uids.
 *  - `roleIsAdminOrOwner` / `adminCompanyUids` gate the "All company
 *    projects" sidebar filter to org owners/admins (kept in lockstep with
 *    `marketplace.ts` / Rust).
 *  - `browseOnlyCompanyProjectChannels` diffs an owner-scoped channel fetch
 *    against the member list, tagging only the channels the caller is NOT in.
 */

import type { Channel } from '../../lib/channels';

export interface EnsureTarget {
  companyUid: string;
  projectId: string;
}

/** Minimal workspace shape needed here (subset of `Workspace`). */
export interface WorkspaceLike {
  slug: string;
  kind?: string;
  cloudUid?: string | null;
  role?: string | null;
  membershipStatus?: string | null;
}

/** Minimal local-project shape needed here (subset of `LocalProjectWire`). */
export interface LocalProjectLike {
  id: string;
  company: string;
}

/** Roles that grant company-admin authority. Kept in lockstep with Rust. */
export function roleIsAdminOrOwner(role: string | null | undefined): boolean {
  const r = (role ?? '').trim().toLowerCase();
  return r === 'admin' || r === 'owner';
}

/** Cloud uids of ACTIVE companies where the user is owner/admin (default-deny). */
export function adminCompanyUids(
  workspaces: ReadonlyArray<WorkspaceLike> | null | undefined,
): string[] {
  const uids: string[] = [];
  for (const w of workspaces ?? []) {
    if (w.kind === 'personal') continue;
    const uid = w.cloudUid?.trim();
    if (!uid) continue;
    const active = (w.membershipStatus ?? 'active').toLowerCase() === 'active';
    if (active && roleIsAdminOrOwner(w.role) && !uids.includes(uid)) uids.push(uid);
  }
  return uids;
}

/**
 * Map local member projects onto (companyUid, projectId) ensure targets.
 * Projects whose company has no cloud uid (local-only company) are skipped.
 */
export function collectEnsureTargets(
  projects: ReadonlyArray<LocalProjectLike> | null | undefined,
  workspaces: ReadonlyArray<WorkspaceLike> | null | undefined,
): EnsureTarget[] {
  const uidBySlug = new Map<string, string>();
  for (const w of workspaces ?? []) {
    const uid = w.cloudUid?.trim();
    if (w.kind !== 'personal' && uid) uidBySlug.set(w.slug, uid);
  }
  const targets: EnsureTarget[] = [];
  const seen = new Set<string>();
  for (const p of projects ?? []) {
    const projectId = p.id?.trim();
    const companyUid = uidBySlug.get(p.company?.trim() ?? '');
    if (!projectId || !companyUid) continue;
    const key = `${companyUid}#${projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ companyUid, projectId });
  }
  return targets;
}

export interface ProvisionerOptions {
  /** Tauri invoke (injectable for tests). */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Debounce window before firing a scheduled batch (default 1500ms). */
  debounceMs?: number;
  /** Timer seams (injectable for tests). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Optional error sink (default: silent). */
  onError?: (err: unknown, target: EnsureTarget) => void;
}

export interface ProjectChannelProvisioner {
  /** Queue targets; fires once per debounce window; dedupes per session. */
  schedule(targets: ReadonlyArray<EnsureTarget>): void;
  /** Cancel any pending flush (component teardown). */
  dispose(): void;
  /** Await the in-flight flush (tests). */
  flushPromise(): Promise<void>;
}

/**
 * Debounced, idempotent ensure-project scheduler.
 *
 * Each (companyUid, projectId) is ensured at most once per provisioner
 * lifetime — the server call is itself idempotent, this just avoids spamming
 * it on every project-list refresh. All failures (including the absent-route
 * 404, which the Rust layer already maps to a silent Default) are swallowed:
 * channel provisioning must never break the project list.
 */
export function createProjectChannelProvisioner(
  options: ProvisionerOptions,
): ProjectChannelProvisioner {
  const debounceMs = options.debounceMs ?? 1500;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;
  const done = new Set<string>();
  const pending = new Map<string, EnsureTarget>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  async function flush(): Promise<void> {
    timer = null;
    const batch = Array.from(pending.values());
    pending.clear();
    for (const target of batch) {
      const key = `${target.companyUid}#${target.projectId}`;
      if (done.has(key)) continue;
      try {
        await options.invoke('ensure_project_channel', {
          companyUid: target.companyUid,
          projectId: target.projectId,
        });
        done.add(key);
      } catch (err) {
        // Silent no-op by contract; retryable next schedule (not marked done).
        options.onError?.(err, target);
      }
    }
  }

  return {
    schedule(targets) {
      let queued = false;
      for (const t of targets) {
        const companyUid = t.companyUid?.trim();
        const projectId = t.projectId?.trim();
        if (!companyUid || !projectId) continue;
        const key = `${companyUid}#${projectId}`;
        if (done.has(key) || pending.has(key)) continue;
        pending.set(key, { companyUid, projectId });
        queued = true;
      }
      if (!queued || pending.size === 0) return;
      if (timer !== null) clearT(timer);
      timer = setT(() => {
        inFlight = flush();
      }, debounceMs);
    },
    dispose() {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      pending.clear();
    },
    flushPromise() {
      return inFlight;
    },
  };
}

/**
 * Diff an owner-scoped `list_channels` fetch against the member channel list:
 * returns ONLY the project channels the caller is not already in, tagged for
 * the "All company projects" filter (rendered browse-only).
 */
export function browseOnlyCompanyProjectChannels(
  memberChannels: ReadonlyArray<Channel>,
  fetched: ReadonlyArray<Channel> | null | undefined,
): Channel[] {
  const memberIds = new Set(memberChannels.map((c) => c.channelId));
  return (fetched ?? []).filter(
    (c) => c.scope === 'project' && !memberIds.has(c.channelId),
  );
}
