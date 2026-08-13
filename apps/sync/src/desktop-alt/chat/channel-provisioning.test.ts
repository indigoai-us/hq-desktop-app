/**
 * US-021 — project-channel auto-activation helpers.
 *
 * Covers: debounce + batch flush, per-session dedupe (idempotent re-schedule),
 * absent-safe silent failure (old server 404 / any error), admin/owner gating
 * for the "All company projects" filter, slug→cloudUid target mapping, and the
 * browse-only diff for the owner listing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../../lib/channels';
import {
  adminCompanyUids,
  browseOnlyCompanyProjectChannels,
  collectEnsureTargets,
  createProjectChannelProvisioner,
  roleIsAdminOrOwner,
} from './channel-provisioning';

const WORKSPACES = [
  { slug: 'personal', kind: 'personal', cloudUid: null, role: null },
  { slug: 'acme', kind: 'company', cloudUid: 'ent_acme', role: 'owner', membershipStatus: 'active' },
  { slug: 'globex', kind: 'company', cloudUid: 'ent_globex', role: 'member', membershipStatus: 'active' },
  { slug: 'initech', kind: 'company', cloudUid: null, role: 'admin', membershipStatus: 'active' },
];

describe('roleIsAdminOrOwner / adminCompanyUids', () => {
  it('accepts owner + admin, default-denies everything else', () => {
    expect(roleIsAdminOrOwner('owner')).toBe(true);
    expect(roleIsAdminOrOwner(' Admin ')).toBe(true);
    expect(roleIsAdminOrOwner('member')).toBe(false);
    expect(roleIsAdminOrOwner(null)).toBe(false);
    expect(roleIsAdminOrOwner(undefined)).toBe(false);
  });

  it('returns only ACTIVE admin/owner companies with a cloud uid', () => {
    expect(adminCompanyUids(WORKSPACES)).toEqual(['ent_acme']);
    expect(
      adminCompanyUids([
        { slug: 'a', kind: 'company', cloudUid: 'ent_a', role: 'owner', membershipStatus: 'invited' },
      ]),
    ).toEqual([]);
    expect(adminCompanyUids(null)).toEqual([]);
  });
});

describe('collectEnsureTargets', () => {
  it('maps member projects onto cloud company uids, skipping local-only companies', () => {
    const targets = collectEnsureTargets(
      [
        { id: 'proj-1', company: 'acme' },
        { id: 'proj-2', company: 'globex' },
        { id: 'proj-3', company: 'initech' }, // no cloudUid → skipped
        { id: 'proj-1', company: 'acme' }, // duplicate → once
        { id: '', company: 'acme' }, // empty id → skipped
      ],
      WORKSPACES,
    );
    expect(targets).toEqual([
      { companyUid: 'ent_acme', projectId: 'proj-1' },
      { companyUid: 'ent_globex', projectId: 'proj-2' },
    ]);
  });
});

describe('createProjectChannelProvisioner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces: rapid schedules collapse into one flush per target', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const p = createProjectChannelProvisioner({ invoke, debounceMs: 500 });

    p.schedule([{ companyUid: 'ent_acme', projectId: 'proj-1' }]);
    vi.advanceTimersByTime(200);
    p.schedule([
      { companyUid: 'ent_acme', projectId: 'proj-1' },
      { companyUid: 'ent_acme', projectId: 'proj-2' },
    ]);
    expect(invoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    await p.flushPromise();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('ensure_project_channel', {
      companyUid: 'ent_acme',
      projectId: 'proj-1',
    });
  });

  it('is idempotent per session: an ensured target is never re-sent', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const p = createProjectChannelProvisioner({ invoke, debounceMs: 100 });

    p.schedule([{ companyUid: 'ent_acme', projectId: 'proj-1' }]);
    vi.advanceTimersByTime(100);
    await p.flushPromise();
    p.schedule([{ companyUid: 'ent_acme', projectId: 'proj-1' }]);
    vi.advanceTimersByTime(100);
    await p.flushPromise();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('swallows failures silently (absent-safe) and allows a later retry', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce('Request failed (status 500)')
      .mockResolvedValue({});
    const errors: unknown[] = [];
    const p = createProjectChannelProvisioner({
      invoke,
      debounceMs: 100,
      onError: (err) => errors.push(err),
    });

    p.schedule([{ companyUid: 'ent_acme', projectId: 'proj-1' }]);
    vi.advanceTimersByTime(100);
    await p.flushPromise();
    expect(errors).toHaveLength(1);

    // Failed target is NOT marked done — a later schedule retries it.
    p.schedule([{ companyUid: 'ent_acme', projectId: 'proj-1' }]);
    vi.advanceTimersByTime(100);
    await p.flushPromise();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('dispose cancels a pending flush', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const p = createProjectChannelProvisioner({ invoke, debounceMs: 100 });
    p.schedule([{ companyUid: 'ent_acme', projectId: 'proj-1' }]);
    p.dispose();
    vi.advanceTimersByTime(1000);
    await p.flushPromise();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips blank targets', () => {
    const invoke = vi.fn().mockResolvedValue({});
    const p = createProjectChannelProvisioner({ invoke, debounceMs: 100 });
    p.schedule([{ companyUid: ' ', projectId: 'x' }, { companyUid: 'ent', projectId: '' }]);
    vi.advanceTimersByTime(1000);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('browseOnlyCompanyProjectChannels', () => {
  const member = { channelId: 'chn_mine', scope: 'project' } as Channel;
  const other = { channelId: 'chn_other', scope: 'project' } as Channel;
  const company = { channelId: 'chn_general', scope: 'company' } as Channel;

  it('returns only project channels the caller is not already in', () => {
    expect(browseOnlyCompanyProjectChannels([member], [member, other, company])).toEqual([
      other,
    ]);
  });

  it('is empty-safe', () => {
    expect(browseOnlyCompanyProjectChannels([], null)).toEqual([]);
  });
});
