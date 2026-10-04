import { describe, expect, it, vi } from 'vitest';

import { resolveFirstLaunchJoinKey } from './desktop-first-launch-join-key';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

describe('first-launch join key', () => {
  it('keeps the continuation identity when first-launch join is enabled', async () => {
    const isEnabled = vi.fn(async () => true);
    const readNativeId = vi.fn(async () => null);

    await expect(
      resolveFirstLaunchJoinKey({
        firstLaunch: true,
        continuationInstallAttemptId: INSTALL_ID,
        isEnabled,
        readNativeId,
      }),
    ).resolves.toBe(INSTALL_ID);

    expect(isEnabled).toHaveBeenCalledOnce();
    expect(readNativeId).not.toHaveBeenCalled();
  });

  it('leaves the early first-launch event on its local id when the flag is off, even with continuation context', async () => {
    const isEnabled = vi.fn(async () => false);
    const readNativeId = vi.fn(async () => INSTALL_ID);

    await expect(
      resolveFirstLaunchJoinKey({
        firstLaunch: true,
        continuationInstallAttemptId: INSTALL_ID,
        isEnabled,
        readNativeId,
      }),
    ).resolves.toBeNull();

    expect(isEnabled).toHaveBeenCalledOnce();
    expect(readNativeId).not.toHaveBeenCalled();
  });

  it('uses the persisted native install id on first launch when context is absent and the flag is on', async () => {
    const isEnabled = vi.fn(async () => true);
    const readNativeId = vi.fn(async () => INSTALL_ID);

    await expect(
      resolveFirstLaunchJoinKey({
        firstLaunch: true,
        continuationInstallAttemptId: null,
        isEnabled,
        readNativeId,
      }),
    ).resolves.toBe(INSTALL_ID);

    expect(isEnabled).toHaveBeenCalledOnce();
    expect(readNativeId).toHaveBeenCalledOnce();
  });

  it('leaves no-context first launches unchanged when the flag is off', async () => {
    const isEnabled = vi.fn(async () => false);
    const readNativeId = vi.fn(async () => INSTALL_ID);

    await expect(
      resolveFirstLaunchJoinKey({
        firstLaunch: true,
        continuationInstallAttemptId: null,
        isEnabled,
        readNativeId,
      }),
    ).resolves.toBeNull();

    expect(readNativeId).not.toHaveBeenCalled();
  });

  it('does not fetch a fallback id outside first launch', async () => {
    const isEnabled = vi.fn(async () => true);
    const readNativeId = vi.fn(async () => INSTALL_ID);

    await expect(
      resolveFirstLaunchJoinKey({
        firstLaunch: false,
        continuationInstallAttemptId: null,
        isEnabled,
        readNativeId,
      }),
    ).resolves.toBeNull();

    expect(isEnabled).not.toHaveBeenCalled();
    expect(readNativeId).not.toHaveBeenCalled();
  });

  it('retains continuation identity on later launches without reading the rollout flag', async () => {
    const isEnabled = vi.fn(async () => false);
    const readNativeId = vi.fn(async () => null);

    await expect(
      resolveFirstLaunchJoinKey({
        firstLaunch: false,
        continuationInstallAttemptId: INSTALL_ID,
        isEnabled,
        readNativeId,
      }),
    ).resolves.toBe(INSTALL_ID);

    expect(isEnabled).not.toHaveBeenCalled();
    expect(readNativeId).not.toHaveBeenCalled();
  });
});
