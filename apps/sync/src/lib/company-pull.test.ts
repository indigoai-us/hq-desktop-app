import { describe, expect, it, vi } from 'vitest';
import {
  initialPullRows,
  pullCompany,
  pullFailures,
  pullSettled,
  pullSucceeded,
  runCompanyPull,
  type CompanyPullDeps,
  type CompanyPullRow,
  type CompanyPullRunResult,
} from './company-pull';

const ACME = { companyUid: 'cmp_acme', slug: 'acme', name: 'Acme' };
const GLOBEX = { companyUid: 'cmp_globex', slug: 'globex', name: 'Globex' };
const CLEAN: CompanyPullRunResult = { errors: [], aborted: false };

function deps(overrides: Partial<CompanyPullDeps> = {}): CompanyPullDeps {
  return {
    runSync: vi.fn(async () => CLEAN),
    provision: vi.fn(async () => ({ status: 'ready' as const, bucketName: 'b' })),
    sleep: vi.fn(async () => {}),
    busyRetryLimit: 3,
    ...overrides,
  };
}

describe('company pull', () => {
  it('pulls each company with a scoped sync and reports per-company progress in order', async () => {
    const d = deps();
    const snapshots: Array<Array<[string, string]>> = [];
    const outcomes: unknown[] = [];
    const rows = await runCompanyPull({
      rows: initialPullRows([ACME, GLOBEX]),
      deps: d,
      onRows: (next) => snapshots.push(next.map((row) => [row.slug, row.status])),
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(d.runSync).toHaveBeenNthCalledWith(1, 'acme');
    expect(d.runSync).toHaveBeenNthCalledWith(2, 'globex');
    expect(snapshots).toEqual([
      [['acme', 'queued'], ['globex', 'queued']],
      [['acme', 'pulling'], ['globex', 'queued']],
      [['acme', 'done'], ['globex', 'queued']],
      [['acme', 'done'], ['globex', 'pulling']],
      [['acme', 'done'], ['globex', 'done']],
    ]);
    expect(pullSettled(rows)).toBe(true);
    expect(pullSucceeded(rows)).toBe(true);
    expect(outcomes).toEqual([
      { companyUid: 'cmp_acme', outcome: 'done', attempt: 1, errorKind: null, selfHealed: false },
      { companyUid: 'cmp_globex', outcome: 'done', attempt: 1, errorKind: null, selfHealed: false },
    ]);
  });

  it('lists a failed company, keeps going, and never reports the pull as succeeded', async () => {
    const d = deps({
      runSync: vi.fn(async (slug: string) =>
        slug === 'acme' ? { errors: [{ company: 'acme', message: 'Access denied' }], aborted: false } : CLEAN,
      ),
    });
    const rows = await runCompanyPull({ rows: initialPullRows([ACME, GLOBEX]), deps: d, onRows: () => {} });

    expect(rows.map((row) => [row.slug, row.status, row.errorKind])).toEqual([
      ['acme', 'failed', 'sync_error'],
      ['globex', 'done', null],
    ]);
    expect(pullSettled(rows)).toBe(true);
    expect(pullSucceeded(rows)).toBe(false);
    expect(pullFailures(rows).map((row) => row.slug)).toEqual(['acme']);
  });

  it('Try again pulls only the failed company and counts the attempt', async () => {
    let fail = true;
    const d = deps({
      runSync: vi.fn(async (slug: string) => {
        if (slug === 'acme' && fail) throw new Error('network down');
        return CLEAN;
      }),
    });
    const first = await runCompanyPull({ rows: initialPullRows([ACME, GLOBEX]), deps: d, onRows: () => {} });
    expect(first[0]).toMatchObject({ status: 'failed', errorKind: 'start_failed', attempts: 1 });

    fail = false;
    const outcomes: unknown[] = [];
    const second = await runCompanyPull({
      rows: first,
      only: ['cmp_acme'],
      deps: d,
      onRows: () => {},
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(d.runSync).toHaveBeenCalledTimes(3);
    expect(second.map((row) => [row.slug, row.status, row.attempts])).toEqual([
      ['acme', 'done', 2],
      ['globex', 'done', 1],
    ]);
    expect(outcomes).toEqual([
      { companyUid: 'cmp_acme', outcome: 'done', attempt: 2, errorKind: null, selfHealed: false },
    ]);
  });

  it('provisions a missing bucket once, then pulls again', async () => {
    const runSync = vi
      .fn<(slug: string) => Promise<CompanyPullRunResult>>()
      .mockResolvedValueOnce({
        errors: [{ company: 'acme', message: 'Entity cmp_acme (acme) has no bucket provisioned. Run VLT-2 bucket provisioning first.' }],
        aborted: false,
      })
      .mockResolvedValueOnce(CLEAN);
    const d = deps({ runSync });
    const result = await pullCompany(ACME, d);
    expect(d.provision).toHaveBeenCalledWith('cmp_acme');
    expect(runSync).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, errorKind: null, selfHealed: true });
  });

  it('fails when provisioning does not finish, without a second sync', async () => {
    const runSync = vi.fn(async () => ({
      errors: [{ message: 'Entity cmp_acme (acme) has no bucket provisioned.' }],
      aborted: false,
    }));
    const d = deps({ runSync, provision: vi.fn(async () => ({ status: 'failed' as const, step: 'timeout' })) });
    expect(await pullCompany(ACME, d)).toEqual({ ok: false, errorKind: 'provisioning', selfHealed: true });
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('waits while another sync is running, then gives up as busy', async () => {
    const runSync = vi
      .fn<(slug: string) => Promise<CompanyPullRunResult>>()
      .mockRejectedValueOnce(new Error('Sync is already running'))
      .mockResolvedValueOnce(CLEAN);
    const d = deps({ runSync });
    expect(await pullCompany(ACME, d)).toMatchObject({ ok: true });
    expect(d.sleep).toHaveBeenCalledTimes(1);

    const alwaysBusy = deps({ runSync: vi.fn(async () => { throw new Error('Sync is already running'); }) });
    expect(await pullCompany(ACME, alwaysBusy)).toMatchObject({ ok: false, errorKind: 'busy' });
    expect(alwaysBusy.runSync).toHaveBeenCalledTimes(4);
  });

  it('treats an aborted or timed-out run as failed', async () => {
    expect(await pullCompany(ACME, deps({ runSync: vi.fn(async () => ({ errors: [], aborted: true })) })))
      .toMatchObject({ ok: false, errorKind: 'aborted' });
    expect(await pullCompany(ACME, deps({ runSync: vi.fn(async () => ({ errors: [], aborted: false, timedOut: true })) })))
      .toMatchObject({ ok: false, errorKind: 'timeout' });
  });

  it('is not settled while a company is waiting or pulling', () => {
    const rows: CompanyPullRow[] = initialPullRows([ACME, GLOBEX]);
    expect(pullSettled(rows)).toBe(false);
    expect(pullSettled([{ ...rows[0]!, status: 'done' }, { ...rows[1]!, status: 'pulling' }])).toBe(false);
    expect(pullSettled([])).toBe(true);
  });

  it('drops duplicate companies and rows without a slug', () => {
    expect(initialPullRows([ACME, ACME, { companyUid: 'cmp_x', slug: '', name: 'X' }]).map((row) => row.slug))
      .toEqual(['acme']);
  });
});
