import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  loadMeetingPermissions,
  permissionState,
  type MeetingPermissionsSnapshot,
} from './permissionState.svelte';

const snapshot: MeetingPermissionsSnapshot = {
  accessibility: 'granted',
  screenCapture: 'granted',
  microphone: 'granted',
  systemAudio: 'granted',
  fullDiskAccess: 'unknown',
  allRequiredGranted: true,
};

describe('meeting permission refresh failures', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    permissionState.meetingPermissions = snapshot;
  });

  it('preserves the prior snapshot for best-effort callers', async () => {
    invokeMock.mockRejectedValueOnce(new Error('IPC unavailable'));

    await expect(loadMeetingPermissions()).resolves.toBe(snapshot);
    expect(permissionState.meetingPermissions).toBe(snapshot);
  });

  it('lets freshness-sensitive callers surface a failed refresh', async () => {
    invokeMock.mockRejectedValueOnce(new Error('IPC unavailable'));

    await expect(
      loadMeetingPermissions({ throwOnError: true }),
    ).rejects.toThrow('IPC unavailable');
    expect(permissionState.meetingPermissions).toBe(snapshot);
  });
});
