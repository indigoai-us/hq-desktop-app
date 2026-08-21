// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import CompanyBoardPanel from '../../src/desktop-alt/panels/CompanyBoardPanel.svelte';
import { stopCompanyStore } from '../../src/desktop-alt/lib/company-store.svelte';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  invokeMock.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  stopCompanyStore();
  host.remove();
});

describe('Personal board rendering', () => {
  it('renders Personal local projects without calling company-only resources', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_local_projects') {
        return [
          {
            id: 'per-proj-1',
            title: 'Ode by Anthropic Opportunity',
            company: 'personal',
            status: 'planned',
            storyCount: 0,
            storiesComplete: 0,
            provenance: { origin: 'personal/board.json' },
          },
        ];
      }
      throw new Error(`company-only command called for Personal: ${command}`);
    });

    component = mount(CompanyBoardPanel, {
      target: host,
      props: {
        slug: 'personal',
        cloudBacked: false,
        connectionIssue: false,
        syncEnabled: true,
      },
    });
    flushSync();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="board-error"]')).toBeNull();
      expect(host.querySelector('[data-testid="overview-pulse"]')?.textContent).toMatch(
        /1\s+projects/,
      );
    });

    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands).toEqual(['get_local_projects']);
    expect(host.textContent).not.toContain('This company is local only');
    expect(host.textContent).not.toContain('Connect this company');
  });
});
