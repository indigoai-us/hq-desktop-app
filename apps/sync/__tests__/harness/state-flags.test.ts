import { describe, expect, it } from 'vitest';

import {
  emptyResult,
  resolveHarnessState,
  resolveLoadingMs,
  withHarnessState,
} from '../../dev-harness/state-flags';

describe('harness ?state= flag', () => {
  it('parses only known states', () => {
    expect(resolveHarnessState('?state=empty')).toBe('empty');
    expect(resolveHarnessState('state=loading&persona=indigo')).toBe('loading');
    expect(resolveHarnessState('?state=bogus')).toBeNull();
    expect(resolveHarnessState('')).toBeNull();
    expect(resolveLoadingMs('?loadingMs=250')).toBe(250);
    expect(resolveLoadingMs('?loadingMs=x')).toBeNull();
  });

  it('empty clears nested lists and hq_pro_fetch bodies', () => {
    expect(emptyResult({ rows: [1, 2], meta: { items: ['a'] }, n: 3 })).toEqual({
      rows: [],
      meta: { items: [] },
      n: 3,
    });
    const fetched = emptyResult({ status: 200, body: JSON.stringify({ secrets: [{ a: 1 }] }) }) as {
      body: string;
    };
    expect(JSON.parse(fetched.body)).toEqual({ secrets: [] });
  });

  it('boot commands always pass through', async () => {
    await expect(withHarnessState('error', 'whoami', () => 'me')).resolves.toBe('me');
  });

  it('error rejects data commands', async () => {
    await expect(withHarnessState('error', 'list_channels', () => [])).rejects.toThrow(
      /simulated failure/,
    );
  });

  it('loading holds forever unless a delay is given', async () => {
    let settled = false;
    void withHarnessState('loading', 'list_channels', () => 1).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    await expect(withHarnessState('loading', 'list_channels', () => 1, 5)).resolves.toBe(1);
  });
});
