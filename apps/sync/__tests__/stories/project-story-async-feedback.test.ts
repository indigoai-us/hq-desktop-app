// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const localProjectReads = vi.hoisted(() => ({
  loadLocalProjectPrd: vi.fn(),
  loadLocalProjectReadme: vi.fn(),
}));

vi.mock('../../src/desktop-alt/lib/local-projects', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/desktop-alt/lib/local-projects')
  >('../../src/desktop-alt/lib/local-projects');
  return { ...actual, ...localProjectReads };
});

const projectMutations = vi.hoisted(() => ({
  setProjectStatus: vi.fn(),
  setStoryPasses: vi.fn(),
  statusOverride: vi.fn(() => null),
  statusPending: vi.fn(() => false),
}));

vi.mock('../../src/desktop-alt/lib/projects-store.svelte', () => ({
  projectsStore: {
    statusOverride: projectMutations.statusOverride,
    statusPending: projectMutations.statusPending,
  },
  setProjectStatus: projectMutations.setProjectStatus,
  setStoryPasses: projectMutations.setStoryPasses,
}));

vi.mock('../../src/desktop-alt/lib/sessions-store.svelte', () => ({
  sessionsStore: { sessions: [] },
  startSessionsStore: vi.fn(),
}));

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, unmount } from 'svelte';
import ProjectDetailView from '../../src/desktop-alt/pages/ProjectDetailView.svelte';
import StoryPanel from '../../src/desktop-alt/v4/StoryPanel.svelte';
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

const project: Project = {
  id: 'async-feedback',
  name: 'Async feedback',
  description: 'Project action feedback fixture',
  company: 'indigo',
  status: 'planned',
  prdPath: 'companies/indigo/projects/async-feedback/prd.json',
  storiesTotal: 1,
  storiesComplete: 0,
};

const story: Story = {
  id: 'US-001',
  title: 'Expose pending feedback',
  description: 'Every action stays legible while native work is pending.',
  acceptanceCriteria: ['Pending state is visible'],
  passes: false,
  labels: [],
  dependsOn: [],
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  localProjectReads.loadLocalProjectPrd.mockResolvedValue({
    name: project.name,
    description: project.description,
    userStories: [story],
    provenance: {},
  });
  localProjectReads.loadLocalProjectReadme.mockResolvedValue(null);
  projectMutations.setProjectStatus.mockResolvedValue({
    ok: true,
    status: 'in_progress',
    error: null,
  });
  projectMutations.setStoryPasses.mockResolvedValue({
    ok: true,
    passes: true,
    error: null,
  });
  tauri.invoke.mockResolvedValue({ hqFolderPath: '' });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.restoreAllMocks();
});

function mountProjectDetail(
  props: Partial<{
    stories: Story[];
    storiesLoading: boolean;
    storiesError: string | null;
    onretryStories: () => void | Promise<void>;
  }> = {},
): void {
  component = mount(ProjectDetailView, {
    target: host,
    props: {
      project,
      stories: [],
      onback: vi.fn(),
      onselectStory: vi.fn(),
      ...props,
    },
  });
  flushSync();
}

describe('project detail async feedback', () => {
  it('announces and labels a pending project status save on its trigger', async () => {
    const statusWrite = deferred<{
      ok: boolean;
      status: string;
      error: string | null;
    }>();
    projectMutations.setProjectStatus.mockReturnValueOnce(statusWrite.promise);
    mountProjectDetail();

    host.querySelector<HTMLButtonElement>('[data-testid="status-trigger"]')?.click();
    flushSync();
    host
      .querySelector<HTMLButtonElement>('[data-testid="status-option-in_progress"]')
      ?.click();
    flushSync();

    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-testid="status-trigger"]',
    );
    expect(trigger?.getAttribute('aria-busy')).toBe('true');
    expect(trigger?.textContent).toContain('Saving…');
    expect(trigger?.disabled).toBe(true);

    statusWrite.resolve({ ok: true, status: 'in_progress', error: null });
    await vi.waitFor(() => {
      flushSync();
      expect(
        host
          .querySelector<HTMLButtonElement>('[data-testid="status-trigger"]')
          ?.getAttribute('aria-busy'),
      ).toBe('false');
    });
  });

  it('keeps a failed story load scoped and retryable while the retry is pending', async () => {
    const retryRequest = deferred<void>();
    const retry = vi.fn(() => retryRequest.promise);
    mountProjectDetail({
      storiesError: 'Could not load this project’s stories.',
      onretryStories: retry,
    });

    const retryButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="story-load-retry"]',
    );
    expect(retryButton?.textContent?.trim()).toBe('Retry');
    retryButton?.click();
    flushSync();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retryButton?.getAttribute('aria-busy')).toBe('true');
    expect(retryButton?.textContent?.trim()).toBe('Retrying…');
    expect(host.querySelector('[data-testid="story-load-error"]')).toBeTruthy();

    retryRequest.resolve();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host
          .querySelector<HTMLButtonElement>('[data-testid="story-load-retry"]')
          ?.getAttribute('aria-busy'),
      ).toBe('false');
    });
  });
});

describe('story panel async feedback', () => {
  function mountStoryPanel(): void {
    component = mount(StoryPanel, {
      target: host,
      props: {
        story,
        project,
        prdPath: project.prdPath,
        onclose: vi.fn(),
      },
    });
    flushSync();
  }

  it('scopes a pending story status save to the status control', async () => {
    const statusWrite = deferred<{
      ok: boolean;
      passes: boolean;
      error: string | null;
    }>();
    projectMutations.setStoryPasses.mockReturnValueOnce(statusWrite.promise);
    mountStoryPanel();

    const done = Array.from(
      host.querySelectorAll<HTMLButtonElement>(
        '[data-testid="task-status-control"] button',
      ),
    ).find((button) => button.textContent?.trim() === 'Done');
    done?.click();
    flushSync();

    const control = host.querySelector<HTMLElement>(
      '[data-testid="task-status-control"]',
    );
    expect(control?.getAttribute('aria-busy')).toBe('true');
    expect(done?.textContent?.trim()).toBe('Saving…');
    expect(done?.disabled).toBe(true);

    statusWrite.resolve({ ok: true, passes: true, error: null });
    await vi.waitFor(() => {
      flushSync();
      expect(
        host
          .querySelector<HTMLElement>('[data-testid="task-status-control"]')
          ?.getAttribute('aria-busy'),
      ).toBe('false');
    });
  });

  it('announces Copy ID work on the originating button', async () => {
    const clipboardWrite = deferred<void>();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => clipboardWrite.promise) },
    });
    mountStoryPanel();

    const copy = host.querySelector<HTMLButtonElement>(
      '[data-testid="copy-story-id"]',
    );
    copy?.click();
    flushSync();

    expect(copy?.getAttribute('aria-busy')).toBe('true');
    expect(copy?.textContent?.trim()).toBe('Copying…');
    expect(copy?.disabled).toBe(true);

    clipboardWrite.resolve();
    await vi.waitFor(() => {
      flushSync();
      const current = host.querySelector<HTMLButtonElement>(
        '[data-testid="copy-story-id"]',
      );
      expect(current?.getAttribute('aria-busy')).toBe('false');
      expect(current?.textContent?.trim()).toBe('Copy ID');
    });
  });
});

describe('project story retry wiring contract', () => {
  function source(relativePath: string): string {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  }

  it.each([
    '../../src/desktop-alt/pages/CompanyProjectsPage.svelte',
    '../../src/desktop-alt/pages/CompanyGoalsPage.svelte',
    '../../src/desktop-alt/panels/CompanyBoardPanel.svelte',
  ])('%s passes its selected-project story loader to the detail retry', (path) => {
    const parent = source(path);
    expect(parent).toContain('function retrySelectedStories()');
    expect(parent).toContain('onretryStories={retrySelectedStories}');
  });
});
