// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, unmount } from 'svelte';
import CompanyClientsPanel from '../../src/desktop-alt/panels/CompanyClientsPanel.svelte';
import CompanyKnowledgePanel from '../../src/desktop-alt/panels/CompanyKnowledgePanel.svelte';
import {
  companyScopedRoot,
  inCompanyScopedRoot,
  isMissingScopedRootError,
} from '../../src/desktop-alt/lib/company-scoped-files';
import type { DirEntry } from '../../src/desktop-alt/lib/file-tree';

const companyPage = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/pages/CompanyPage.svelte'),
  'utf8',
);

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

function clientDirectory(index: number): DirEntry {
  const slug = `client-${String(index).padStart(2, '0')}`;
  return {
    name: slug,
    path: `companies/taikun/clients/${slug}`,
    isDir: true,
    hasChildren: true,
  };
}

describe('read-only Clients view', () => {
  it('defines a strict company clients scope', () => {
    const root = companyScopedRoot('taikun', 'clients');
    expect(root).toBe('companies/taikun/clients');
    expect(inCompanyScopedRoot(root, root)).toBe(true);
    expect(inCompanyScopedRoot(`${root}/acme/engagement.md`, root)).toBe(true);
    expect(inCompanyScopedRoot('companies/other/clients/acme/engagement.md', root)).toBe(false);
    expect(inCompanyScopedRoot('companies/taikun/knowledge/clients/acme.md', root)).toBe(false);
  });

  it('recognizes only the requested root as a calm missing-folder state', () => {
    const root = 'companies/taikun/clients';
    expect(isMissingScopedRootError(`directory not found: "${root}"`, root)).toBe(true);
    expect(isMissingScopedRootError(new Error(`directory not found: "${root}"`), root)).toBe(true);
    expect(
      isMissingScopedRootError(`directory not found: "${root}/acme"`, root),
    ).toBe(false);
    expect(isMissingScopedRootError('file explorer requires a signed-in user', root)).toBe(false);
  });

  it('renders a 27-client lazy tree and previews a selected client file', async () => {
    const clients = Array.from({ length: 27 }, (_, index) => clientDirectory(index + 1));
    tauri.invoke.mockImplementation(async (command: string, args?: Record<string, string>) => {
      if (command === 'list_hq_dir' && args?.relPath === 'companies/taikun/clients') {
        return clients;
      }
      if (
        command === 'list_hq_dir' &&
        args?.relPath === 'companies/taikun/clients/client-01'
      ) {
        return [
          {
            name: 'engagement.md',
            path: 'companies/taikun/clients/client-01/engagement.md',
            isDir: false,
            hasChildren: false,
          },
        ];
      }
      if (
        command === 'get_company_file_content' &&
        args?.path === 'companies/taikun/clients/client-01/engagement.md'
      ) {
        return '# Client 01\nActive engagement';
      }
      throw new Error(`unexpected invoke: ${command} ${JSON.stringify(args)}`);
    });

    component = mount(CompanyClientsPanel, {
      target: host,
      props: { slug: 'taikun' },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="file-tree-row"]')).toHaveLength(27);
    });
    expect(tauri.invoke).toHaveBeenCalledWith('list_hq_dir', {
      relPath: 'companies/taikun/clients',
    });

    host
      .querySelector<HTMLElement>('[data-path="companies/taikun/clients/client-01"]')
      ?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-path="companies/taikun/clients/client-01/engagement.md"]'),
      ).toBeTruthy();
    });

    host
      .querySelector<HTMLElement>(
        '[data-path="companies/taikun/clients/client-01/engagement.md"]',
      )
      ?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="file-preview-pane"]')).toBeTruthy();
      expect(host.textContent).toContain('Active engagement');
    });
    expect(tauri.invoke).toHaveBeenCalledWith('get_company_file_content', {
      path: 'companies/taikun/clients/client-01/engagement.md',
    });

    const focusSearch = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(focusSearch);
    expect(focusSearch.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      host.querySelector('[data-testid="clients-search"]'),
    );

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    host.querySelector('[data-testid="file-preview-pane"]')?.dispatchEvent(escape);
    flushSync();
    expect(escape.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-testid="file-preview-pane"]')).toBeNull();
  });

  it('does not preview an out-of-scope entry even if a malformed listing returns one', async () => {
    tauri.invoke.mockResolvedValueOnce([
      {
        name: 'secret.md',
        path: 'companies/other/clients/secret.md',
        isDir: false,
        hasChildren: false,
      },
    ]);

    component = mount(CompanyClientsPanel, {
      target: host,
      props: { slug: 'taikun' },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-path="companies/other/clients/secret.md"]')).toBeTruthy();
    });

    host
      .querySelector<HTMLElement>('[data-path="companies/other/clients/secret.md"]')
      ?.click();
    flushSync();

    expect(host.querySelector('[data-testid="file-preview-pane"]')).toBeNull();
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'get_company_file_content',
      expect.anything(),
    );
  });

  it('rejects lazy loads that leave the company clients subtree', async () => {
    tauri.invoke.mockResolvedValueOnce([
      {
        name: 'other-company',
        path: 'companies/other/clients',
        isDir: true,
        hasChildren: true,
      },
    ]);

    component = mount(CompanyClientsPanel, {
      target: host,
      props: { slug: 'taikun' },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-path="companies/other/clients"]')).toBeTruthy();
    });

    host.querySelector<HTMLElement>('[data-path="companies/other/clients"]')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="file-tree-node-error"]')).toBeTruthy();
    });
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it('shows a calm empty state when the clients directory does not exist', async () => {
    tauri.invoke.mockRejectedValueOnce(
      new Error('directory not found: "companies/taikun/clients"'),
    );

    component = mount(CompanyClientsPanel, {
      target: host,
      props: { slug: 'taikun' },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="company-clients-missing"]')).toBeTruthy();
    });

    expect(host.textContent).toContain('No clients yet');
    expect(host.textContent).not.toContain('Files unavailable');
  });

  it('keeps authorization and transient root failures visible and retryable', async () => {
    tauri.invoke.mockRejectedValueOnce(new Error('company file access denied'));

    component = mount(CompanyClientsPanel, {
      target: host,
      props: { slug: 'taikun' },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="file-tree-error"]')).toBeTruthy();
    });

    expect(host.textContent).toContain('Files unavailable');
    expect(host.querySelector('[data-testid="company-clients-missing"]')).toBeNull();
  });

  it('preserves the Knowledge panel error behavior while sharing the browser', async () => {
    tauri.invoke.mockRejectedValueOnce(
      new Error('directory not found: "companies/taikun/knowledge"'),
    );

    component = mount(CompanyKnowledgePanel, {
      target: host,
      props: { slug: 'taikun' },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="file-tree-error"]')).toBeTruthy();
    });

    expect(host.querySelector('[data-testid="company-knowledge-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="company-knowledge-missing"]')).toBeNull();
  });

  it('keeps the clients browser behind the existing pending-membership gate', () => {
    const gateMarker = companyPage.indexOf('data-testid="company-invite-gate"');
    const gateStart = companyPage.lastIndexOf('{#if pendingInvite}', gateMarker);
    const acceptedStart = companyPage.indexOf('{:else}', gateMarker);
    const clientsPanel = companyPage.indexOf('<CompanyClientsPanel', acceptedStart);

    expect(gateMarker).toBeGreaterThan(-1);
    expect(gateStart).toBeGreaterThan(-1);
    expect(acceptedStart).toBeGreaterThan(gateStart);
    expect(clientsPanel).toBeGreaterThan(acceptedStart);
    expect(companyPage.slice(gateStart, acceptedStart)).not.toContain('CompanyClientsPanel');
  });
});
