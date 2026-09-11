// @vitest-environment happy-dom

/**
 * US-018 SHIPPING PATH — the Office a signed-in Mac user can actually open.
 *
 * `main.ts` mounts exactly one shell (`HqWorkWorkShell` → @hq/work `WorkShell`
 * → @hq/ui `DesktopApp`). A surface that is only wired into some other tree is
 * not shipped, whatever its own tests say. This file pins the plumbing along
 * that one path:
 *
 *   * the native capabilities object the host builds carries the calling seams;
 *   * HqWorkWorkShell hands them to WorkShell, and WorkShell to DesktopApp;
 *   * "Start a room" in the mounted panel reaches `calls_open_window` with a
 *     credential-free target;
 *   * and the desktop-alt binding re-uses the ONE @hq/ui implementation.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, tick, unmount } from 'svelte';
import { meet } from '@hq/ui';
import { createSyncPlatformAdapter, type SyncInvokeFn } from '@hq/platform';

import {
  createNativeCallsHost,
  createNativeWorkShellCapabilities,
  type NativeInvokeFn,
} from './work-shell-capabilities';
import {
  BUNDLED_EVIDENCE_MAX_AGE_MS,
  SERVICE_EVIDENCE,
} from '../call/service-evidence';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const RUN_AT = Date.parse((SERVICE_EVIDENCE as { runAt: string }).runAt);

describe('US-018 shipping path: the mounted shell is the one that gets the seams', () => {
  it('mounts HqWorkWorkShell and nothing else', () => {
    const boot = read('./boot.ts');
    const main = read('./main.ts');
    expect(boot).toContain("return 'hq-work'");
    expect(main).toContain("import('./HqWorkWorkShell.svelte')");
    // If this ever gains a second mount, the plumbing below must be repeated
    // for it — or the Office becomes unreachable on that branch.
    expect(main).not.toContain("import('./DesktopApp.svelte')");
  });

  it('carries the calling seams down HqWorkWorkShell → WorkShell → DesktopApp', () => {
    expect(read('./HqWorkWorkShell.svelte')).toContain(
      'callsHost={capabilities.calls}',
    );
    const workShell = read('../../../../apps/work/src/lib/WorkShell.svelte');
    expect(workShell).toContain('callsHost?: OfficeCallsHost | null;');
    expect(workShell).toContain('{callsHost}');
    const desktopApp = read(
      '../../../../packages/ui/src/shell/DesktopApp.svelte',
    );
    expect(desktopApp).toContain('callsHost?: OfficeCallsHost | null;');
    expect(desktopApp).toContain('<OfficePanel');
  });

  it('keeps ONE Office implementation — desktop-alt only binds to it', () => {
    const alt = read('./panels/OfficePanel.svelte');
    expect(alt).toContain('<meet.OfficePanel');
    expect(alt).toContain('createNativeCallsHost');
    // No second copy of the sequencing: no preflight, no whoami, no store.
    expect(alt).not.toContain('createOfficeStore');
    expect(alt).not.toContain('preflight');
    // The prose may name the command; only a second INVOKE would duplicate it.
    expect(alt).not.toMatch(/invoke\w*\(\s*['"]calls_open_window/);
  });
});

describe('US-018 shipping path: the native calls host', () => {
  it('bundles the build-time receipt with its own explicit lifetime', async () => {
    const invoke = vi.fn(async () => 'device-1' as unknown);
    const host = createNativeCallsHost(invoke as NativeInvokeFn);
    expect(host.serviceEvidence).toBe(SERVICE_EVIDENCE);
    expect(host.evidenceMaxAgeMs).toBe(BUNDLED_EVIDENCE_MAX_AGE_MS);
    expect(await host.resolveDeviceId?.()).toBe('device-1');
    expect(invoke).toHaveBeenCalledWith('device_fingerprint');
  });

  it('is part of the capabilities the shell host hands to WorkShell', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_auth_session') return { status: 'active' };
      if (cmd === 'whoami') return { personUid: 'prs_self' };
      return null as unknown;
    });
    const capabilities = await createNativeWorkShellCapabilities({
      invoke: invoke as NativeInvokeFn,
    });
    expect(capabilities.calls.serviceEvidence).toBe(SERVICE_EVIDENCE);
    expect(typeof capabilities.calls.openCallWindow).toBe('function');
  });

  it('opens the call window through calls_open_window and nothing else', async () => {
    const invoke = vi.fn(async () => null as unknown);
    const host = createNativeCallsHost(invoke as NativeInvokeFn);
    await host.openCallWindow({
      sessionId: 'cmp_a:room_1:call_1:4',
      companyUid: 'cmp_a',
      roomId: 'room_1',
      callId: 'call_1',
      epoch: 4,
      self: { personUid: 'prs_self', deviceId: 'device-1' },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0] as unknown as [
      string,
      { target: unknown },
    ];
    expect(cmd).toBe('calls_open_window');
    expect(args.target).toEqual({
      sessionId: 'cmp_a:room_1:call_1:4',
      companyUid: 'cmp_a',
      roomId: 'room_1',
      callId: 'call_1',
      epoch: 4,
      self: { personUid: 'prs_self', deviceId: 'device-1' },
    });
  });
});

describe('US-018 shipping path: "Start a room" reaches the host seam', () => {
  let host: HTMLDivElement | null = null;
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(RUN_AT + 60_000);
    tauri.invoke.mockReset();
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      await Promise.resolve();
      await tick();
      flushSync();
    }
  }

  it('creates a room, then hands a credential-free target to openCallWindow', async () => {
    const opened: meet.OfficeCallTarget[] = [];
    const invokeFn = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'whoami') return { personUid: 'prs_self' };
      if (cmd === 'get_auth_state') {
        return { authenticated: true, accountId: 'prs_self' };
      }
      if (cmd === 'hq_pro_fetch') {
        const url = String(args?.url ?? '');
        if (url.startsWith('/v1/meet-native/office')) {
          return {
            status: 200,
            body: JSON.stringify({
              companyUid: 'cmp_indigo',
              observedAt: Date.now(),
              people: [
                {
                  personUid: 'prs_self',
                  connectivity: 'online',
                  willingness: 'knock',
                },
              ],
            }),
          };
        }
        if (url === '/v1/meet-native/rooms') {
          return {
            status: 200,
            body: JSON.stringify({
              room: { roomId: 'room_1' },
              call: { callId: 'call_1', epoch: 7 },
            }),
          };
        }
        return { status: 404, body: '{"code":"NOT_FOUND"}' };
      }
      return null as unknown;
    });

    // Exactly what the shipping shell mounts: the @hq/ui panel, the desktop
    // adapter, and the host's own calling seams.
    const adapter = createSyncPlatformAdapter({
      invoke: (command, args) => invokeFn(command, args),
    });
    const callsHost: meet.OfficeCallsHost = {
      ...createNativeCallsHost(<T,>(command: string, args?: Record<string, unknown>) =>
        invokeFn(command, args) as Promise<T>,
      ),
      resolveDeviceId: async () => 'device-1',
      openCallWindow: async (target) => {
        opened.push(target);
      },
    };

    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(meet.OfficePanel, {
      target: host,
      props: {
        adapter,
        callsHost,
        companyUid: 'cmp_indigo',
        companyLabel: 'Indigo',
      } as never,
    });
    flushSync();
    await settle();

    const start = host.querySelector<HTMLButtonElement>(
      '[data-testid="office-start-room"]',
    );
    expect(start).not.toBeNull();
    start!.click();
    await settle();

    expect(opened).toHaveLength(1);
    const target = opened[0]!;
    expect(target).toEqual({
      sessionId: 'cmp_indigo:room_1:call_1:7',
      companyUid: 'cmp_indigo',
      roomId: 'room_1',
      callId: 'call_1',
      epoch: 7,
      self: { personUid: 'prs_self', deviceId: 'device-1' },
    });
    // Credential-free: ids and timings only, nothing that could authorize.
    const serialized = JSON.stringify(target).toLowerCase();
    for (const banned of ['token', 'secret', 'password', 'authorization', 'jwt']) {
      expect(serialized).not.toContain(banned);
    }
    // And the @hq/ui panel itself never touched Tauri.
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});

// Keep the unused-import linter honest about the type-only usage above.
export type { SyncInvokeFn };
