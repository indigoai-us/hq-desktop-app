// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const localProjects = vi.hoisted(() => ({
  loadCompanyGoals: vi.fn(),
  loadCompanyProjectProvenance: vi.fn(),
  loadLocalProjects: vi.fn(),
  loadLocalProjectStories: vi.fn(),
  loadLocalProjectPrd: vi.fn(),
  loadLocalProjectReadme: vi.fn(),
}));

vi.mock('../../src/desktop-alt/lib/local-projects', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/desktop-alt/lib/local-projects')
  >('../../src/desktop-alt/lib/local-projects');
  return { ...actual, ...localProjects };
});

vi.mock('../../src/desktop-alt/lib/sessions-store.svelte', () => ({
  sessionsStore: { sessions: [] },
  startSessionsStore: vi.fn(),
}));

vi.mock('../../src/desktop-alt/lib/projects-store.svelte', () => ({
  projectsStore: {
    projects: [],
    statusOverride: vi.fn(() => null),
    statusPending: vi.fn(() => false),
  },
  setProjectStatus: vi.fn(),
}));

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, unmount } from 'svelte';
import CompanyFileTree from '../../src/desktop-alt/components/CompanyFileTree.svelte';
import CompanyProjectsPage from '../../src/desktop-alt/pages/CompanyProjectsPage.svelte';
import type { DirEntry } from '../../src/desktop-alt/lib/file-tree';
import type { Project, Story } from '../../src/desktop-alt/lib/projects-model';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function project(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    description: `${id} description`,
    company: 'indigo',
    status: 'planned',
    prdPath: `companies/indigo/projects/${id}/prd.json`,
    storiesTotal: 1,
    storiesComplete: 0,
  };
}

function story(id: string, title: string): Story {
  return {
    id,
    title,
    description: `${title} detail`,
    acceptanceCriteria: [],
    passes: false,
    labels: [],
    dependsOn: [],
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  localProjects.loadCompanyGoals.mockResolvedValue({ objectives: [] });
  localProjects.loadCompanyProjectProvenance.mockResolvedValue([]);
  localProjects.loadLocalProjects.mockResolvedValue([
    project('alpha'),
    project('bravo'),
  ]);
  localProjects.loadLocalProjectPrd.mockResolvedValue({
    name: 'Project',
    userStories: [],
    provenance: {},
  });
  localProjects.loadLocalProjectReadme.mockResolvedValue(null);
  tauri.invoke.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.restoreAllMocks();
});

describe('project story selection races', () => {
  it('never commits an older project story load into the newly selected project', async () => {
    const alpha = deferred<Story[]>();
    const bravo = deferred<Story[]>();
    localProjects.loadLocalProjectStories.mockImplementation((prdPath: string) =>
      prdPath.includes('/alpha/') ? alpha.promise : bravo.promise,
    );

    component = mount(CompanyProjectsPage, {
      target: host,
      props: { slug: 'indigo' },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[aria-label="Project Project alpha"]')).toBeTruthy();
    });

    host
      .querySelector<HTMLButtonElement>('[aria-label="Project Project alpha"]')
      ?.click();
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="detail-back"]')?.click();
    flushSync();
    host
      .querySelector<HTMLButtonElement>('[aria-label="Project Project bravo"]')
      ?.click();
    flushSync();

    bravo.resolve([story('US-B', 'Bravo-only story')]);
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('Bravo-only story');
    });

    alpha.resolve([story('US-A', 'Stale Alpha story')]);
    await alpha.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(host.textContent).toContain('Bravo-only story');
    expect(host.textContent).not.toContain('Stale Alpha story');
  });
});

describe('company file tree rejection recovery', () => {
  it('keeps a failed folder retryable and loads its children on Retry', async () => {
    const rootEntries: DirEntry[] = [
      {
        name: 'projects',
        path: 'companies/indigo/projects',
        isDir: true,
        hasChildren: true,
      },
    ];
    let folderAttempts = 0;
    const loadChildren = vi.fn(async (path: string): Promise<DirEntry[]> => {
      if (path === 'companies/indigo') return rootEntries;
      folderAttempts += 1;
      if (folderAttempts === 1) throw new Error('temporary read failure');
      return [
        {
          name: 'restored.md',
          path: 'companies/indigo/projects/restored.md',
          isDir: false,
          hasChildren: false,
        },
      ];
    });

    component = mount(CompanyFileTree, {
      target: host,
      props: {
        rootPath: 'companies/indigo',
        loadChildren,
      },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-path="companies/indigo/projects"]'),
      ).toBeTruthy();
    });

    const folderRow = host.querySelector<HTMLElement>(
      '[data-path="companies/indigo/projects"]',
    );
    folderRow?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="file-tree-node-error"]'),
      ).toBeTruthy();
    });

    const tree = host.querySelector<HTMLElement>(
      '[data-testid="company-file-tree"]',
    );
    const nodeError = host.querySelector<HTMLElement>(
      '[data-testid="file-tree-node-error"]',
    );
    expect(nodeError?.closest('[role="treeitem"]')).toBe(folderRow);
    expect(
      [...(tree?.children ?? [])].every(
        (child) => child.getAttribute('role') === 'treeitem',
      ),
    ).toBe(true);

    const retry = host.querySelector<HTMLButtonElement>(
      '[data-testid="file-tree-node-retry"]',
    );
    expect(retry?.textContent?.trim()).toBe('Retry');
    retry?.focus();
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    retry?.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(folderRow?.getAttribute('aria-expanded')).toBe('true');
    retry?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('restored.md');
    });
    expect(loadChildren).toHaveBeenCalledTimes(3);
    expect(
      host.querySelector('[data-testid="file-tree-node-error"]'),
    ).toBeNull();
  });

  it('recovers a rejected root load without remounting the tree', async () => {
    let attempts = 0;
    const loadChildren = vi.fn(async (): Promise<DirEntry[]> => {
      attempts += 1;
      if (attempts === 1) throw new Error('root temporarily unavailable');
      return [
        {
          name: 'README.md',
          path: 'companies/indigo/README.md',
          isDir: false,
          hasChildren: false,
        },
      ];
    });

    component = mount(CompanyFileTree, {
      target: host,
      props: {
        rootPath: 'companies/indigo',
        loadChildren,
      },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="file-tree-error"]')).toBeTruthy();
    });

    expect(
      host
        .querySelector('[data-testid="company-file-tree"]')
        ?.getAttribute('role'),
    ).toBeNull();

    const retry = host.querySelector<HTMLButtonElement>(
      '[data-testid="file-tree-root-retry"]',
    );
    expect(retry?.textContent?.trim()).toBe('Retry');
    retry?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain('README.md');
    });
    expect(loadChildren).toHaveBeenCalledTimes(2);
  });
});
