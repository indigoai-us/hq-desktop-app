import { describe, expect, it, vi } from 'vitest';
import {
  RecordingActionAckCoordinator,
  RecordingActionTimeoutError,
} from './recordingActionAck';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('RecordingActionAckCoordinator', () => {
  it('coalesces concurrent starts for the same meeting until authoritative start', async () => {
    const coordinator = new RecordingActionAckCoordinator({ timeoutMs: 1_000 });
    const dispatch = vi.fn().mockResolvedValue('recording-1');

    const first = coordinator.start('window-1', dispatch);
    const retry = coordinator.start('window-1', dispatch);
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(coordinator.hasPending('window-1')).toBe(true);

    coordinator.started('window-1');
    await expect(first).resolves.toBe('recording-1');
    await expect(retry).resolves.toBe('recording-1');
    expect(coordinator.hasPending('window-1')).toBe(false);
  });

  it('correlates out-of-order lifecycle events by window id', async () => {
    const coordinator = new RecordingActionAckCoordinator({ timeoutMs: 1_000 });
    const first = coordinator.start('window-1', async () => 'recording-1');
    const second = coordinator.start('window-2', async () => 'recording-2');

    coordinator.started('window-2');
    await expect(second).resolves.toBe('recording-2');
    expect(coordinator.hasPending('window-1')).toBe(true);

    coordinator.started('window-1');
    await expect(first).resolves.toBe('recording-1');
  });

  it('rejects matching callers on authoritative recording errors', async () => {
    const coordinator = new RecordingActionAckCoordinator({ timeoutMs: 1_000 });
    const first = coordinator.start('window-1', async () => 'recording-1');
    const retry = coordinator.start('window-1', async () => 'duplicate');

    coordinator.failed('window-1', 'recall: microphone unavailable');

    await expect(first).rejects.toThrow('recall: microphone unavailable');
    await expect(retry).rejects.toThrow('recall: microphone unavailable');
  });

  it('times out an ACK caller without redispatching a still-live semantic start', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new RecordingActionAckCoordinator({ timeoutMs: 50 });
      const dispatch = vi.fn().mockResolvedValue('recording-1');
      const first = coordinator.start('window-1', dispatch);
      const firstTimeout = expect(first).rejects.toBeInstanceOf(
        RecordingActionTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(50);
      await firstTimeout;
      expect(coordinator.hasPending('window-1')).toBe(true);

      const retry = coordinator.start('window-1', dispatch);
      await Promise.resolve();
      expect(dispatch).toHaveBeenCalledOnce();

      coordinator.started('window-1');
      await expect(retry).resolves.toBe('recording-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for both dispatch and an early authoritative start event', async () => {
    const coordinator = new RecordingActionAckCoordinator({ timeoutMs: 1_000 });
    const dispatch = deferred<string>();
    const result = coordinator.start('window-1', () => dispatch.promise);

    coordinator.started('window-1');
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    dispatch.resolve('recording-1');
    await expect(result).resolves.toBe('recording-1');
  });

  it('clears a failed dispatch so a later explicit retry can dispatch again', async () => {
    const coordinator = new RecordingActionAckCoordinator({ timeoutMs: 1_000 });
    const dispatch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('bridge unavailable'))
      .mockResolvedValueOnce('recording-2');

    await expect(coordinator.start('window-1', dispatch)).rejects.toThrow(
      'bridge unavailable',
    );
    const retry = coordinator.start('window-1', dispatch);
    coordinator.started('window-1');

    await expect(retry).resolves.toBe('recording-2');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
