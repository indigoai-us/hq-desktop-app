import { describe, expect, it, vi } from 'vitest';
import {
  createFirstLaunchSignInReachQueue,
  FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES,
} from './first-launch-signin-reach-queue';

const ATTEMPT_IDS = [
  '22222222-2222-4222-8222-222222222221',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222223',
];
const DAY_MS = 24 * 60 * 60 * 1000;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe('first-launch sign-in reach queue', () => {
  it('bounds persisted records and retains only the newest attempt outcomes', async () => {
    const storage = memoryStorage();
    const send = vi.fn(async () => false);
    const queue = createFirstLaunchSignInReachQueue({ storage, send, now: () => 100, maxEntries: 2 });

    await queue.enqueue(ATTEMPT_IDS[0]!, 'quit');
    await queue.enqueue(ATTEMPT_IDS[1]!, 'update-gate');
    await queue.enqueue(ATTEMPT_IDS[2]!, 'reached-signin');

    const raw = storage.values.get('hq:first-launch-signin-reach:v1');
    expect(raw).toBeDefined();
    const persisted = JSON.parse(raw!) as { entries: Array<{ installAttemptId: string }> };
    expect(persisted.entries).toHaveLength(2);
    expect(persisted.entries.map((entry) => entry.installAttemptId)).toEqual(ATTEMPT_IDS.slice(1));
  });

  it('drops expired outcomes and rejects values outside the closed set', async () => {
    const storage = memoryStorage();
    const send = vi.fn(async () => false);
    const old = createFirstLaunchSignInReachQueue({ storage, send, now: () => 0 });
    await old.enqueue(ATTEMPT_IDS[0]!, 'quit');
    send.mockClear();

    const current = createFirstLaunchSignInReachQueue({ storage, send, now: () => 8 * DAY_MS });
    await current.enqueue(ATTEMPT_IDS[1]!, 'not-a-reach-outcome');
    expect(send).not.toHaveBeenCalled();
    const persisted = JSON.parse(storage.values.get('hq:first-launch-signin-reach:v1')!) as { entries: unknown[] };
    expect(persisted.entries).toEqual([]);
    expect(FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES).toContain('quit');
  });

  it('flushes a pending record after a reporter restart and does not resend an acknowledged row', async () => {
    const storage = memoryStorage();
    const unavailable = vi.fn(async () => false);
    const firstProcess = createFirstLaunchSignInReachQueue({ storage, send: unavailable, now: () => 100 });
    await firstProcess.enqueue(ATTEMPT_IDS[0]!, 'window-closed');
    expect(unavailable).toHaveBeenCalledTimes(1);

    const recovered = vi.fn(async () => true);
    const nextProcess = createFirstLaunchSignInReachQueue({ storage, send: recovered, now: () => 200 });
    await nextProcess.flush();
    expect(recovered).toHaveBeenCalledWith({
      installAttemptId: ATTEMPT_IDS[0],
      outcome: 'window-closed',
      recordedAt: 100,
    });

    const thirdProcess = createFirstLaunchSignInReachQueue({
      storage,
      send: vi.fn(async () => true),
      now: () => 300,
    });
    await thirdProcess.flush();
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
