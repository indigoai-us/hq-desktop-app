import { describe, expect, it, vi } from 'vitest';
import {
  createOutboundMessage,
  defaultBackoffMs,
  retrySend,
  runSend,
  sendStatusLabel,
  type OutboundMessage,
} from './sendStateMachine';

function sleepImmediate(): (ms: number) => Promise<void> {
  return async () => undefined;
}

describe('sendStateMachine', () => {
  it('creates messages in pending with retained body', () => {
    const msg = createOutboundMessage('hello world', () => '2026-06-10T12:00:00.000Z');
    expect(msg.status).toBe('pending');
    expect(msg.body).toBe('hello world');
    expect(msg.attempts).toBe(0);
    expect(msg.createdAt).toBe('2026-06-10T12:00:00.000Z');
    expect(msg.clientId).toMatch(/^local-send-/);
  });

  it('ack → delivered after a successful send', async () => {
    const msg = createOutboundMessage('ship it');
    const send = vi.fn().mockResolvedValue(undefined);
    const changes: OutboundMessage[] = [];

    const result = await runSend(msg, {
      send,
      sleep: sleepImmediate(),
      onChange: (m) => changes.push({ ...m }),
    });

    expect(result.status).toBe('delivered');
    expect(result.body).toBe('ship it');
    expect(result.attempts).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('ship it');
    expect(changes.some((c) => c.status === 'sending')).toBe(true);
    expect(changes.at(-1)?.status).toBe('delivered');
    expect(sendStatusLabel(result.status)).toBe('Delivered');
  });

  it('repeated failure → failed after backoff exhaustion; body never dropped', async () => {
    const msg = createOutboundMessage('keep me');
    const send = vi.fn().mockRejectedValue(new Error('network down'));
    const sleeps: number[] = [];
    const changes: OutboundMessage[] = [];

    const result = await runSend(msg, {
      send,
      maxAttempts: 3,
      backoffMs: defaultBackoffMs,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onChange: (m) => changes.push({ ...m }),
    });

    expect(result.status).toBe('failed');
    expect(result.body).toBe('keep me');
    expect(result.attempts).toBe(3);
    expect(result.error).toMatch(/network down/);
    expect(send).toHaveBeenCalledTimes(3);
    // Two backoffs between three attempts.
    expect(sleeps).toEqual([defaultBackoffMs(2), defaultBackoffMs(3)]);
    expect(sendStatusLabel(result.status)).toBe('Failed — tap to retry');
    // Object identity retained (caller can keep list reference).
    expect(result).toBe(msg);
  });

  it('retry from failed → delivered', async () => {
    const msg = createOutboundMessage('retry me');
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'))
      .mockResolvedValueOnce(undefined);

    const failed = await runSend(msg, {
      send,
      maxAttempts: 3,
      sleep: sleepImmediate(),
    });
    expect(failed.status).toBe('failed');
    expect(failed.body).toBe('retry me');

    const recovered = await retrySend(failed, {
      send,
      maxAttempts: 3,
      sleep: sleepImmediate(),
    });
    expect(recovered.status).toBe('delivered');
    expect(recovered.body).toBe('retry me');
    expect(recovered.clientId).toBe(msg.clientId);
    // Original 3 failures + 1 success on retry budget.
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('never drops the message object on failure', async () => {
    const msg = createOutboundMessage('precious');
    const send = vi.fn().mockRejectedValue('nope');
    await runSend(msg, { send, maxAttempts: 2, sleep: sleepImmediate() });
    expect(msg.body).toBe('precious');
    expect(msg.status).toBe('failed');
    expect(msg.clientId).toBeTruthy();
  });

  it('does not re-send an already delivered message', async () => {
    const msg = createOutboundMessage('done');
    msg.status = 'delivered';
    msg.attempts = 1;
    const send = vi.fn();
    await runSend(msg, { send, sleep: sleepImmediate() });
    expect(send).not.toHaveBeenCalled();
    expect(msg.status).toBe('delivered');
  });
});
