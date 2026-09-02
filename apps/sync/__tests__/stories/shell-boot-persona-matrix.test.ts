// @vitest-environment happy-dom
/**
 * Cheap PR gate: the desktop shell must leave the loading skeleton for every
 * release-gate persona, including the non-Indigo empty inbox that v0.10.178
 * froze on. Mounts HqWorkDesktopShell against the shared harness personas.
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
import {
  PERSONA_IDS,
  PERSONAS,
  createPersonaInvoke,
  isPersonaId,
  resolveHarnessPersona,
  type PersonaId,
} from '../../dev-harness/personas';

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

describe('release-gate personas', () => {
  it('defines the four identities the v0.10.178 hole needed', () => {
    expect([...PERSONA_IDS]).toEqual([
      'empty-inbox',
      'personal-only',
      'multi-company',
      'indigo',
    ]);
    expect(PERSONAS['empty-inbox'].isIndigo).toBe(false);
    expect(PERSONAS['empty-inbox'].channels).toEqual([]);
    expect(PERSONAS['empty-inbox'].workspaces.some((row) => row.kind === 'company')).toBe(
      true,
    );
    expect(PERSONAS['personal-only'].workspaces.every((row) => row.kind === 'personal')).toBe(
      true,
    );
    expect(
      PERSONAS['multi-company'].workspaces.filter((row) => row.kind === 'company'),
    ).toHaveLength(2);
    expect(PERSONAS.indigo.isIndigo).toBe(true);
    expect(PERSONAS.indigo.whoami.email).toMatch(/getindigo\.ai$/);
    expect(isPersonaId('empty-inbox')).toBe(true);
    expect(isPersonaId('indigo-admin')).toBe(false);
  });

  it('resolves ?persona= from the harness query and ignores unknown ids', () => {
    expect(resolveHarnessPersona('?view=shell&persona=empty-inbox')?.id).toBe('empty-inbox');
    expect(resolveHarnessPersona('persona=indigo')?.id).toBe('indigo');
    expect(resolveHarnessPersona('?persona=not-a-persona')).toBeNull();
    expect(resolveHarnessPersona('')).toBeNull();
  });
});

describe('desktop shell boots for every release-gate persona', () => {
  it.each(PERSONA_IDS)(
    '%s leaves the loading skeleton and fires shell_ready within 5s',
    async (id) => {
      const { calls, persona } = await mountPersona(id);

      expect(host.querySelector('[data-testid="hq-work-identity-error"]')).toBeNull();
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
