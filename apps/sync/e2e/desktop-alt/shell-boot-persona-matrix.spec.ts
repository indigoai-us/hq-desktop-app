// @vitest-environment happy-dom
/**
 * Desktop-alt e2e twin of the stories persona boot matrix.
 *
 * The CI "Shell boot matrix" job runs this file so a required check exists
 * outside the giant frontend vitest blob. Same personas, same shell, same
 * "leave the skeleton / fire shell_ready" contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('tests inject invokeFn');
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.10.179'),
  setTheme: vi.fn(async () => {}),
}));

import { flushSync, mount, unmount } from 'svelte';
import HqWorkDesktopShell from '../../src/desktop-alt/HqWorkDesktopShell.svelte';
import { PERSONA_IDS, createPersonaInvoke, type PersonaId } from '../../dev-harness/personas';

const BOOT_DEADLINE_MS = 5_000;

async function flush(times = 48): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  flushSync();
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

async function mountPersona(id: PersonaId) {
  const { invokeFn, calls, persona } = createPersonaInvoke(id);
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(HqWorkDesktopShell, {
    target: host,
    props: { invokeFn, bootTimeoutMs: 40 },
  });
  await flush();
  return { calls, persona };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  try {
    window.localStorage?.clear?.();
  } catch {
    /* Node 22 may not expose localStorage in this worker */
  }
});

describe('desktop-alt persona shell boot matrix', () => {
  it.each(PERSONA_IDS)(
    '%s paints a workspace (not the skeleton) and reports shell_ready',
    async (id) => {
      const { calls, persona } = await mountPersona(id);
      expect(host.querySelector('[data-testid="desktop-shell"]')).toBeTruthy();
      await vi.waitFor(
        () => {
          expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
          if (persona.expectedPaint === 'setup') {
            expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeTruthy();
          } else {
            expect(
              host.querySelector('[data-testid="conversation-composer"]') ||
                host.querySelector('[data-conversation-id]') ||
                host.querySelector('[data-testid="setup-channel-intro"]'),
            ).toBeTruthy();
          }
          expect(calls).toContain('shell_ready');
        },
        { timeout: BOOT_DEADLINE_MS },
      );
    },
    15_000,
  );
});
