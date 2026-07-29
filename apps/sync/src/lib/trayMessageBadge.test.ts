import { describe, expect, it, vi } from 'vitest';
import {
  normalizeTrayMessageBadgeCount,
  TrayMessageBadgePublisher,
} from './trayMessageBadge';

describe('TrayMessageBadgePublisher', () => {
  it('serializes writes and coalesces rapid changes to the newest count', async () => {
    let releaseFirst: (() => void) | undefined;
    const writes: number[] = [];
    const writer = vi.fn(async (count: number) => {
      writes.push(count);
      if (count === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });
    const publisher = new TrayMessageBadgePublisher(writer);

    const first = publisher.publish(1);
    await Promise.resolve();
    const second = publisher.publish(2);
    const third = publisher.publish(3);
    releaseFirst?.();
    await Promise.all([first, second, third]);

    expect(writes).toEqual([1, 3]);
  });

  it('normalizes invalid counts before crossing the native command boundary', async () => {
    const writes: number[] = [];
    const publisher = new TrayMessageBadgePublisher(async (count) => {
      writes.push(count);
    });

    await publisher.publish(-4);
    await publisher.publish(2.9);
    await publisher.publish(Number.NaN);
    await publisher.publish(Number.MAX_SAFE_INTEGER);

    expect(writes).toEqual([0, 2, 0, 0xffff_ffff]);
    expect(normalizeTrayMessageBadgeCount(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('reports a bridge failure and accepts a later fresh snapshot', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const writes: number[] = [];
    const publisher = new TrayMessageBadgePublisher(
      async (count) => {
        writes.push(count);
        if (fail) throw new Error('bridge unavailable');
      },
      (error) => errors.push(error),
      async () => {},
    );

    await publisher.publish(4);
    fail = false;
    await publisher.publish(5);

    expect(writes).toEqual([4, 4, 4, 5]);
    expect(errors).toHaveLength(3);
  });

  it('publishes the newest value when it arrives before an older write rejects', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const writes: number[] = [];
    const errors: unknown[] = [];
    const publisher = new TrayMessageBadgePublisher(
      async (count) => {
        writes.push(count);
        if (count === 4) {
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
      },
      (error) => errors.push(error),
      async () => {},
    );

    const first = publisher.publish(4);
    await Promise.resolve();
    const newest = publisher.publish(9);
    rejectFirst?.(new Error('stale bridge write failed'));
    await Promise.all([first, newest]);

    expect(writes).toEqual([4, 9]);
    expect(errors).toHaveLength(1);
  });
});
