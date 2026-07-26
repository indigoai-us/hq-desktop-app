import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createResourceCache } from '../../src/desktop-alt/lib/resource-cache.svelte';

describe('US-006 shared resource cache', () => {
  it('deduplicates concurrent consumers and records the last successful value', async () => {
    const cache = createResourceCache();
    let resolve!: (value: string[]) => void;
    const loader = vi.fn(() => new Promise<string[]>((done) => (resolve = done)));

    const summary = cache.load('acme:activity', loader);
    const panel = cache.load('acme:activity', loader);
    expect(loader).toHaveBeenCalledTimes(1);

    const result = ['one'];
    resolve(result);
    await expect(Promise.all([summary, panel])).resolves.toEqual([result, result]);
    expect(cache.read('acme:activity')).toBe(result);
    expect(cache.inspect('acme:activity').error).toBeNull();
  });

  it('serves fresh data within TTL and stale data while one revalidation runs', async () => {
    let now = 1_000;
    const cache = createResourceCache({ ttlMs: 100, now: () => now });
    const loader = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await cache.load('acme:board', loader);
    now += 50;
    await expect(cache.load('acme:board', loader)).resolves.toBe('first');
    expect(loader).toHaveBeenCalledTimes(1);

    now += 51;
    expect(cache.read('acme:board')).toBe('first');
    await expect(cache.load('acme:board', loader)).resolves.toBe('second');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps last-success data on error and invalidates only matching workspace resources', async () => {
    let now = 10;
    const cache = createResourceCache({ ttlMs: 100, now: () => now });
    await cache.load('acme:board', async () => 'board');
    await cache.load('other:board', async () => 'other');
    now += 10;
    cache.invalidate((key) => key.startsWith('acme:'));

    await expect(cache.load('acme:board', async () => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline',
    );
    expect(cache.read('acme:board')).toBe('board');
    expect(cache.inspect('acme:board').error).toBeInstanceOf(Error);
    await cache.load('other:board', vi.fn(async () => 'unexpected'));
    expect(cache.read('other:board')).toBe('other');
  });

  it('keeps launch metadata cheap and centralizes company-resource requests', () => {
    const app = readFileSync(join(process.cwd(), 'src/desktop-alt/DesktopApp.svelte'), 'utf8');
    const store = readFileSync(
      join(process.cwd(), 'src/desktop-alt/lib/company-store.svelte.ts'),
      'utf8',
    );

    expect(app).toContain('startCompanyStore();');
    expect(app).not.toMatch(/startCompanyStore\(\s*nextCompanies/);
    expect(store.match(/invoke<.*?>?\('get_company_/g)?.length).toBe(5);
    expect(store).toContain('setActiveCompanyResource');
    expect(store).toContain('invalidateCompanyResources');
  });
});
