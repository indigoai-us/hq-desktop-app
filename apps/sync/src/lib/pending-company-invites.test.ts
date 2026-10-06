import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flushPendingCompanyInvites,
  MAX_AGE_MS,
  MAX_ATTEMPTS,
  PENDING_COMPANY_INVITES_KEY,
  queuePendingCompanyInvites,
  readPendingCompanyInvites,
} from './pending-company-invites';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

const done = { cardId: 'team:invite', actionId: 'invite', state: 'done' };

afterEach(() => vi.restoreAllMocks());

describe('pending company invites', () => {
  it('queues invites per company and merges duplicates', () => {
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [{ email: 'ada@example.com', role: 'member' }], () => 1);
    queuePendingCompanyInvites(
      storage,
      'cmp_a',
      [
        { email: 'ADA@example.com', role: 'member' },
        { email: 'grace@example.com', role: 'member' },
      ],
      () => 2,
    );
    expect(readPendingCompanyInvites(storage)).toEqual([
      {
        companyUid: 'cmp_a',
        queuedAt: 1,
        attempts: 0,
        invites: [
          { email: 'ada@example.com', role: 'member' },
          { email: 'grace@example.com', role: 'member' },
        ],
      },
    ]);
  });

  it('keeps invites queued while the company is not provisioned', async () => {
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [{ email: 'ada@example.com', role: 'member' }]);
    const runCompanyTabAction = vi.fn(async () => done);
    const report = await flushPendingCompanyInvites(storage, {
      runCompanyTabAction,
      readCompanyProvisioned: async () => false,
    });
    expect(runCompanyTabAction).not.toHaveBeenCalled();
    expect(report.waiting).toEqual(['cmp_a']);
    expect(readPendingCompanyInvites(storage)).toHaveLength(1);
  });

  it('keeps invites queued when the status read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [{ email: 'ada@example.com', role: 'member' }]);
    const runCompanyTabAction = vi.fn(async () => done);
    await flushPendingCompanyInvites(storage, {
      runCompanyTabAction,
      readCompanyProvisioned: async () => {
        throw new Error('offline');
      },
    });
    expect(runCompanyTabAction).not.toHaveBeenCalled();
    expect(readPendingCompanyInvites(storage)).toHaveLength(1);
  });

  it('sends the invites once the company is provisioned and clears the queue', async () => {
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [{ email: 'ada@example.com', role: 'member' }]);
    const runCompanyTabAction = vi.fn(async () => done);
    const report = await flushPendingCompanyInvites(storage, {
      runCompanyTabAction,
      readCompanyProvisioned: async (uid) => uid === 'cmp_a',
    });
    expect(runCompanyTabAction).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUid: 'cmp_a',
        values: { email: 'ada@example.com', role: 'member', inviteSurface: 'desktop' },
      }),
    );
    expect(report.sent).toEqual([{ companyUid: 'cmp_a', count: 1 }]);
    expect(storage.getItem(PENDING_COMPANY_INVITES_KEY)).toBeNull();
  });

  it('retries only the refused invites, then drops them after the attempt limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [
      { email: 'ada@example.com', role: 'member' },
      { email: 'grace@example.com', role: 'member' },
    ]);
    const runCompanyTabAction = vi.fn(async (args: { values: Record<string, string> }) =>
      args.values.email === 'grace@example.com'
        ? { ...done, state: 'blocked', reason: 'No seats left.' }
        : done,
    );
    const api = { runCompanyTabAction, readCompanyProvisioned: async () => true } as never;
    const first = await flushPendingCompanyInvites(storage, api);
    expect(first.failed).toEqual([{ companyUid: 'cmp_a', email: 'grace@example.com', reason: 'No seats left.' }]);
    expect(readPendingCompanyInvites(storage)[0]?.invites).toEqual([
      { email: 'grace@example.com', role: 'member' },
    ]);
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) await flushPendingCompanyInvites(storage, api);
    expect(readPendingCompanyInvites(storage)).toEqual([]);
    expect(error).toHaveBeenCalled();
    // ada was sent exactly once.
    expect(
      runCompanyTabAction.mock.calls.filter(([args]) => args.values.email === 'ada@example.com'),
    ).toHaveLength(1);
  });

  it('drops entries that waited longer than the limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [{ email: 'ada@example.com', role: 'member' }], () => 0);
    const runCompanyTabAction = vi.fn(async () => done);
    const report = await flushPendingCompanyInvites(
      storage,
      { runCompanyTabAction, readCompanyProvisioned: async () => true },
      () => MAX_AGE_MS + 1,
    );
    expect(report.dropped).toEqual(['cmp_a']);
    expect(runCompanyTabAction).not.toHaveBeenCalled();
  });

  it('shares one pass between concurrent flushes', async () => {
    const storage = memoryStorage();
    queuePendingCompanyInvites(storage, 'cmp_a', [{ email: 'ada@example.com', role: 'member' }]);
    const runCompanyTabAction = vi.fn(async () => done);
    const api = { runCompanyTabAction, readCompanyProvisioned: async () => true };
    await Promise.all([flushPendingCompanyInvites(storage, api), flushPendingCompanyInvites(storage, api)]);
    expect(runCompanyTabAction).toHaveBeenCalledTimes(1);
  });

  it('ignores a corrupt queue instead of throwing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage();
    storage.setItem(PENDING_COMPANY_INVITES_KEY, '{not json');
    expect(readPendingCompanyInvites(storage)).toEqual([]);
  });
});
