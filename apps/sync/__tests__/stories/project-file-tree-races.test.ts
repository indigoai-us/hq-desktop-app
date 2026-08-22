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
  setStoryPasses: vi.fn(
    async (
      _prdPath: string,
      _storyId: string,
      _previous: boolean,
      next: boolean,
    ) => ({ ok: true, passes: next, error: null }),
  ),
}));

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, unmount } from 'svelte';
import CompanyFileTree from '../../src/desktop-alt/components/CompanyFileTree.svelte';
import CompanyGoalsPage from '../../src/desktop-alt/pages/CompanyGoalsPage.svelte';
import CompanyProjectsPage from '../../src/desktop-alt/pages/CompanyProjectsPage.svelte';
import type { DirEntry } from '../../src/desktop-alt/lib/file-tree';
import type { ProjectProvenanceRecord } from '../../src/desktop-alt/lib/local-projects';
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
  vi.clearAllMocks();
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
  it('renders the Personal portfolio without company-only provenance or goals loaders', async () => {
    localProjects.loadLocalProjects.mockResolvedValue([
      {
        ...project('personal-alpha'),
        company: 'personal',
        prdPath: 'personal/projects/personal-alpha/prd.json',
      },
    ]);

    component = mount(CompanyProjectsPage, {
      target: host,
      props: { slug: 'personal', companyUid: 'must-not-be-used' },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[aria-label="Project Project personal-alpha"]')).toBeTruthy();
    });
    expect(localProjects.loadCompanyProjectProvenance).not.toHaveBeenCalled();
    expect(localProjects.loadCompanyGoals).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      'list_company_members',
      expect.anything(),
    );
  });

  it('renders an honest Personal goals empty state without company-only loaders', async () => {
    localProjects.loadLocalProjects.mockResolvedValue([
      {
        ...project('personal-alpha'),
        company: 'personal',
        prdPath: 'personal/projects/personal-alpha/prd.json',
      },
    ]);

    component = mount(CompanyGoalsPage, {
      target: host,
      props: { slug: 'personal' },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="empty-goals-state"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="goals-error"]')).toBeNull();
    });
    expect(localProjects.loadLocalProjects).toHaveBeenCalledOnce();
    expect(localProjects.loadCompanyProjectProvenance).not.toHaveBeenCalled();
    expect(localProjects.loadCompanyGoals).not.toHaveBeenCalled();
  });

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

  it('reloads open tasks when authoritative cloud provenance arrives after local history', async () => {
    const cloud = deferred<ProjectProvenanceRecord[]>();
    const localProject: Project = {
      ...project('alpha'),
      provenance: {
        owner: null,
        assignee: null,
        creator: 'Local Git Author',
        origin: 'companies/indigo/projects/alpha/prd.json',
      },
      creatorFallback: 'Local Git Author',
    };
    localProjects.loadLocalProjects.mockResolvedValue([localProject]);
    localProjects.loadCompanyProjectProvenance.mockReturnValue(cloud.promise);
    localProjects.loadLocalProjectStories.mockImplementation(
      async (_prdPath: string, provenance: Project['provenance']) => [
        {
          ...story('US-A', 'Attribution-sensitive story'),
          provenance,
        },
      ],
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
    await vi.waitFor(() => {
      expect(localProjects.loadLocalProjectStories).toHaveBeenCalledTimes(1);
    });
    expect(localProjects.loadLocalProjectStories.mock.calls[0]?.[1]).toMatchObject({
      creator: 'Local Git Author',
      owner: null,
    });

    cloud.resolve([
      {
        id: 'alpha',
        prdPath: 'companies/indigo/projects/alpha/prd.json',
        provenance: {
          owner: 'Cloud Owner',
          assignee: null,
          creator: null,
          origin: 'hq-cloud',
        },
      },
    ]);

    await vi.waitFor(() => {
      flushSync();
      expect(localProjects.loadLocalProjectStories).toHaveBeenCalledTimes(2);
    });
    expect(localProjects.loadLocalProjectStories.mock.calls[1]?.[1]).toMatchObject({
      owner: 'Cloud Owner',
      creator: null,
      origin: 'hq-cloud',
    });
    expect(host.textContent).toContain('Owner');
    expect(host.textContent).toContain('Cloud Owner');
    expect(host.textContent).not.toContain('Local Git Author');
  });

  it('does not let a pre-mutation provenance reread restore an old passes value', async () => {
    const cloud = deferred<ProjectProvenanceRecord[]>();
    const staleProvenanceRead = deferred<Story[]>();
    let reads = 0;
    localProjects.loadCompanyProjectProvenance.mockReturnValue(cloud.promise);
    localProjects.loadLocalProjectStories.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [story('US-A', 'Mutable story')];
      return staleProvenanceRead.promise;
    });

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
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[aria-label="Story US-A: Mutable story"]'),
      ).toBeTruthy();
    });
    host
      .querySelector<HTMLButtonElement>('[aria-label="Story US-A: Mutable story"]')
      ?.click();
    flushSync();

    cloud.resolve([
      {
        id: 'alpha',
        prdPath: 'companies/indigo/projects/alpha/prd.json',
        provenance: {
          owner: 'Cloud Owner',
          assignee: null,
          creator: null,
          origin: 'hq-cloud',
        },
      },
    ]);
    await vi.waitFor(() => {
      expect(localProjects.loadLocalProjectStories).toHaveBeenCalledTimes(2);
    });

    const doneButton = () =>
      Array.from(
        host.querySelectorAll<HTMLButtonElement>(
          '[data-testid="task-status-control"] button',
        ),
      ).find((button) => button.textContent?.trim() === 'Done');
    doneButton()?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(doneButton()?.classList.contains('active')).toBe(true);
    });

    staleProvenanceRead.resolve([story('US-A', 'Mutable story')]);
    await staleProvenanceRead.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();

    expect(doneButton()?.classList.contains('active')).toBe(true);
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
