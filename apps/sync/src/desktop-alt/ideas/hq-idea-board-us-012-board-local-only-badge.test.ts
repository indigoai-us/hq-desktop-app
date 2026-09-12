// @vitest-environment happy-dom
//
// US-012 AC3, the board half: "Sync off ... shows a persistent 'local only'
// badge in the board header." US-012 shipped `localOnlyBadge` as an unrendered
// seam; these tests hold the wiring, and hold the wording to what the capture
// write path actually delivers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.fn();
const listen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { mount, tick, unmount } from 'svelte';
import IdeasBoard from './IdeasBoard.svelte';

/** The full `IdeasSettingsState` wire shape, so the mock host is complete. */
function settings(over: { syncEnabled: boolean; capturesRoot?: string }) {
  return {
    extractionMode: 'local',
    syncEnabled: over.syncEnabled,
    defaultCompany: null,
    activeCompany: 'indigo',
    imageMaxEdge: 2000,
    imageMaxEdgeChoices: [1200, 2000, 4000],
    captureChord: 'Alt+Shift+KeyC',
    captureChordDisplay: '⌥⇧C',
    modelDisclosure: 'disclosure',
    localOnly: !over.syncEnabled,
    capturesRoot:
      over.capturesRoot ??
      (over.syncEnabled ? '/tmp/HQ/companies/indigo/ideas' : '/tmp/HQ/workspace/ideas-local/indigo'),
  };
}

/**
 * A complete host: every command the board issues on mount answers, so a badge
 * assertion can never pass or fail for want of an unrelated mock.
 */
function host(settingsResponse: unknown): void {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case 'ideas_list_captures':
        return [];
      case 'ideas_list_companies':
        return ['indigo'];
      case 'ideas_get_settings':
        return settingsResponse;
      default:
        return { mimeType: 'image/png', dataBase64: 'AAAA' };
    }
  });
}

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function render(): Promise<HTMLDivElement> {
  target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(IdeasBoard, { target, props: { slug: 'indigo' } });
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
  return target;
}

function badge(el: HTMLDivElement): HTMLElement | null {
  return el.querySelector('[data-testid="ideas-board-local-only"]');
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockImplementation(async () => () => {});
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  target?.remove();
});

describe('US-012 — local-only badge in the board header', () => {
  it('is absent while captures sync to the company vault', async () => {
    host(settings({ syncEnabled: true }));
    expect(badge(await render())).toBeNull();
  });

  it('is shown in the header when sync is off', async () => {
    host(settings({ syncEnabled: false }));
    const el = await render();

    const node = badge(el);
    expect(node).not.toBeNull();
    expect(node?.textContent?.trim()).toBe('local only');
    // Persistent, and in the header row — not a toast and not in the grid.
    expect(el.querySelector('.board-top [data-testid="ideas-board-local-only"]')).not.toBeNull();
  });

  it('names the root new captures go to, and the limit of the claim', async () => {
    host(settings({ syncEnabled: false, capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo' }));
    const title = badge(await render())?.getAttribute('title') ?? '';

    expect(title).toContain('/tmp/HQ/workspace/ideas-local/indigo');
    expect(title).toContain('not synced to your team');
    // The badge must not read as retroactive: nothing moves captures that were
    // already written to the vault, so it says so.
    expect(title).toContain('still in the vault and still sync');
    expect(title).not.toContain('Your captures stay on this machine');
  });

  it('renders the board without a badge when the settings read fails', async () => {
    // A failed settings read must not assert a privacy posture, and must not
    // take the grid down with it.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'ideas_get_settings') throw new Error('no such command');
      if (cmd === 'ideas_list_captures') return [];
      if (cmd === 'ideas_list_companies') return ['indigo'];
      return { mimeType: 'image/png', dataBase64: 'AAAA' };
    });
    const el = await render();

    expect(badge(el)).toBeNull();
    expect(el.querySelector('[data-testid="ideas-board"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="ideas-error"]')).toBeNull();
  });
});
