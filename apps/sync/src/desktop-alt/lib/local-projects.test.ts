import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './projects-model';
import {
  applyProjectProvenance,
  dedupeProjects,
  indexProjectProvenance,
  loadCompanyProjectProvenance,
  loadLocalProjectPrd,
  loadLocalProjectStories,
  loadLocalProjects,
  projectIdentity,
  toProject,
  toStory,
  withProjectStatus,
} from './local-projects';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'hq-desktop-app',
  title: 'HQ Desktop app',
  description: 'Native workspace',
  company: 'indigo',
  status: 'active',
  prdPath: 'companies/indigo/projects/hq-desktop-app/prd.json',
  storiesTotal: 4,
  storiesComplete: 1,
  ...overrides,
});

describe('local project identity', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('collapses an exact project path delivered more than once', () => {
    const original = project();
    const duplicate = project({ title: 'Duplicate scan result' });

    expect(dedupeProjects([original, duplicate])).toEqual([original]);
  });

  it('keeps distinct project ids that point at the same PRD', () => {
    const first = project();
    const second = project({
      id: 'hq-desktop-redesign',
      title: 'Desktop redesign',
    });

    expect(dedupeProjects([first, second])).toEqual([first, second]);
    expect(projectIdentity(first)).not.toBe(projectIdentity(second));
  });

  it('keeps same-company projects with repeated ids when their PRD paths differ', () => {
    const first = project();
    const second = project({
      title: 'Second project with legacy id',
      prdPath: 'companies/indigo/projects/hq-desktop-app-v2/prd.json',
    });

    expect(dedupeProjects([first, second])).toHaveLength(2);
    expect(new Set([projectIdentity(first), projectIdentity(second)]).size).toBe(2);
  });

  it('ignores a late status completion for a duplicate id with another PRD path', () => {
    const first = project();
    const second = project({
      title: 'Second project with legacy id',
      prdPath: 'companies/indigo/projects/hq-desktop-app-v2/prd.json',
    });
    const firstIdentity = projectIdentity(first);

    expect(withProjectStatus(first, firstIdentity, 'completed')).toMatchObject({
      status: 'completed',
    });
    expect(withProjectStatus(second, firstIdentity, 'completed')).toBe(second);
  });

  it('keeps the same project id isolated across companies', () => {
    const indigo = project();
    const amass = project({
      company: 'amass',
      prdPath: 'companies/amass/projects/hq-desktop-app/prd.json',
    });

    expect(dedupeProjects([indigo, amass])).toHaveLength(2);
    expect(projectIdentity(indigo)).not.toBe(projectIdentity(amass));
  });

  it('normalizes equivalent relative PRD paths before deduping', () => {
    const posix = project();
    const windows = project({
      id: ' hq-desktop-app ',
      prdPath: '.\\companies\\indigo//projects/hq-desktop-app/prd.json',
    });

    expect(projectIdentity(windows)).toBe(projectIdentity(posix));
    expect(dedupeProjects([posix, windows])).toEqual([posix]);
  });

  it('falls back to trimmed company and id when a project has no PRD path', () => {
    expect(
      projectIdentity(project({ company: ' indigo ', id: ' hq-desktop-app ', prdPath: '' })),
    ).toBe('indigo:id:hq-desktop-app');
  });

  it('dedupes normalized projects at the Tauri adapter boundary', async () => {
    invokeMock.mockResolvedValue([
      {
        id: 'hq-desktop-app',
        title: 'HQ Desktop app',
        company: 'indigo',
        prdPath: 'companies/indigo/projects/hq-desktop-app/prd.json',
        storyCount: 4,
        storiesComplete: 1,
      },
      {
        id: 'hq-desktop-app',
        title: 'Duplicate scan result',
        company: 'indigo',
        prdPath: '.\\companies\\indigo\\projects\\hq-desktop-app\\prd.json',
        storyCount: 4,
        storiesComplete: 1,
      },
    ]);

    const loaded = await loadLocalProjects();

    expect(invokeMock).toHaveBeenCalledWith('get_local_projects');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe('HQ Desktop app');
  });

  it.each([
    ['null', null],
    ['an object', { id: 'not-an-array' }],
  ])('treats %s from get_local_projects as an empty project list', async (_label, value) => {
    invokeMock.mockResolvedValue(value);

    await expect(loadLocalProjects()).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith('get_local_projects');
  });
});

describe('local/cloud provenance adapter', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('keeps normalized project provenance from the local Rust contract', () => {
    expect(
      toProject({
        id: 'p-1',
        title: 'Launch',
        company: 'indigo',
        storyCount: 2,
        storiesComplete: 0,
        provenance: {
          owner: 'Maya',
          creator: 'Corey',
          origin: 'HQ plan',
        },
      }),
    ).toMatchObject({
      provenance: {
        owner: 'Maya',
        assignee: null,
        creator: 'Corey',
        origin: 'HQ plan',
      },
    });
  });

  it('uses an actionable project file as origin without guessing a person', () => {
    expect(
      toProject({
        id: 'p-1',
        title: 'Launch',
        company: 'indigo',
        prdPath: '.\\companies\\indigo\\projects\\launch\\prd.json',
        storyCount: 2,
        storiesComplete: 0,
      }).provenance,
    ).toEqual({
      owner: null,
      assignee: null,
      creator: null,
      origin: 'companies/indigo/projects/launch/prd.json',
    });

    expect(
      toProject({
        id: 'board-only',
        title: 'Board only',
        company: 'indigo',
        storyCount: 0,
        storiesComplete: 0,
      }).provenance?.origin,
    ).toBe('companies/indigo/board.json');
  });

  it('normalizes legacy task assignee/creator/source aliases and metadata fallbacks', () => {
    expect(
      toStory({
        id: 'US-001',
        title: 'Trace it',
        assigneeName: 'Ada',
        created_by: { email: 'corey@example.com' },
        metadata: { owner: 'Maya', source: 'Linear import' },
      }),
    ).toMatchObject({
      provenance: {
        owner: 'Maya',
        assignee: 'Ada',
        creator: 'corey@example.com',
        origin: 'Linear import',
      },
    });
  });

  it('uses the loaded PRD path for stories without explicit source metadata', async () => {
    invokeMock.mockResolvedValue({
      name: 'Launch',
      userStories: [
        { id: 'US-001', title: 'Trace it' },
        { id: 'US-002', title: 'Imported', source: 'Linear import' },
      ],
    });

    const stories = await loadLocalProjectStories(
      '.\\companies\\indigo\\projects\\launch\\prd.json',
    );

    expect(invokeMock).toHaveBeenCalledWith('get_local_project_prd', {
      prdPath: '.\\companies\\indigo\\projects\\launch\\prd.json',
    });
    expect(stories[0].provenance).toEqual({
      owner: null,
      assignee: null,
      creator: null,
      origin: 'companies/indigo/projects/launch/prd.json',
    });
    expect(stories[1].provenance?.origin).toBe('Linear import');
  });

  it('indexes cloud attribution by normalized path and id, then fills only missing local fields', async () => {
    invokeMock.mockResolvedValue([
      {
        id: 'p-1',
        prdPath: '.\\companies\\indigo\\projects\\launch\\prd.json',
        creator: 'Cloud Creator',
        owner: 'Cloud Owner',
        origin: 'Cloud board',
      },
    ]);

    const records = await loadCompanyProjectProvenance('indigo');
    expect(invokeMock).toHaveBeenCalledWith('get_company_project_creators', {
      slug: 'indigo',
    });
    const index = indexProjectProvenance(records);
    const merged = applyProjectProvenance(
      project({
        id: 'p-1',
        prdPath: 'companies/indigo/projects/launch/prd.json',
        provenance: {
          owner: 'Local Owner',
          assignee: null,
          creator: null,
          origin: null,
        },
      }),
      index,
    );

    expect(merged.provenance).toEqual({
      owner: 'Local Owner',
      assignee: null,
      creator: 'Cloud Creator',
      origin: 'Cloud board',
    });
  });

  it('uses an id fallback only when that id identifies one cloud project', () => {
    const unique = indexProjectProvenance([
      {
        id: 'p-1',
        prdPath: 'companies/indigo/projects/launch/prd.json',
        provenance: {
          owner: 'Maya',
          assignee: null,
          creator: null,
          origin: 'Cloud board',
        },
      },
    ]);
    expect(
      applyProjectProvenance(
        project({
          id: 'p-1',
          prdPath: 'companies/indigo/projects/moved-launch/prd.json',
        }),
        unique,
      ).provenance,
    ).toMatchObject({ owner: 'Maya' });

    const repeated = indexProjectProvenance([
      {
        id: 'p-1',
        prdPath: 'companies/indigo/projects/launch-a/prd.json',
        provenance: {
          owner: 'Maya',
          assignee: null,
          creator: null,
          origin: 'Cloud board',
        },
      },
      {
        id: 'p-1',
        prdPath: 'companies/indigo/projects/launch-b/prd.json',
        provenance: {
          owner: 'Ada',
          assignee: null,
          creator: null,
          origin: 'Cloud board',
        },
      },
    ]);

    expect(
      applyProjectProvenance(
        project({
          id: 'p-1',
          prdPath: 'companies/indigo/projects/launch-a/prd.json',
        }),
        repeated,
      ).provenance,
    ).toMatchObject({ owner: 'Maya' });
    expect(
      applyProjectProvenance(
        project({
          id: 'p-1',
          prdPath: 'companies/indigo/projects/unmatched/prd.json',
        }),
        repeated,
      ).provenance,
    ).toEqual({
      owner: null,
      assignee: null,
      creator: null,
      origin: 'companies/indigo/projects/unmatched/prd.json',
    });
  });

  it('ranks explicit local origin above cloud and cloud above a derived file path', () => {
    const index = indexProjectProvenance([
      {
        id: 'p-1',
        prdPath: 'companies/indigo/projects/launch/prd.json',
        provenance: {
          owner: null,
          assignee: null,
          creator: null,
          origin: 'Cloud board',
        },
      },
    ]);
    const derived = toProject({
      id: 'p-1',
      title: 'Launch',
      company: 'indigo',
      prdPath: 'companies/indigo/projects/launch/prd.json',
      storyCount: 0,
      storiesComplete: 0,
    });

    expect(applyProjectProvenance(derived, index).provenance?.origin).toBe(
      'Cloud board',
    );
    expect(
      applyProjectProvenance(
        {
          ...derived,
          provenance: { ...derived.provenance!, origin: 'Local plan' },
        },
        index,
      ).provenance?.origin,
    ).toBe('Local plan');
  });

  it('normalizes project-level PRD provenance for detail fallback', async () => {
    invokeMock.mockResolvedValue({
      name: 'Launch',
      description: 'Ship it',
      provenance: {
        creator: { displayName: 'Corey' },
      },
      metadata: {
        owner: 'Maya',
        source: 'HQ plan',
      },
      userStories: [],
    });

    await expect(loadLocalProjectPrd('companies/indigo/projects/launch/prd.json'))
      .resolves.toMatchObject({
        provenance: {
          owner: 'Maya',
          assignee: null,
          creator: 'Corey',
          origin: 'HQ plan',
        },
      });
  });

  it('uses the PRD path for detail provenance when metadata has no source', async () => {
    invokeMock.mockResolvedValue({
      name: 'Launch',
      description: 'Ship it',
      metadata: {},
      userStories: [],
    });

    await expect(loadLocalProjectPrd('./companies/indigo/projects/launch/prd.json'))
      .resolves.toMatchObject({
        provenance: {
          owner: null,
          assignee: null,
          creator: null,
          origin: 'companies/indigo/projects/launch/prd.json',
        },
      });
  });

  it('drops cloud rows that carry no displayable attribution', async () => {
    invokeMock.mockResolvedValue([
      { id: 'p-1', creator: '  ', owner: null, source: { uid: 'opaque' } },
    ]);

    await expect(loadCompanyProjectProvenance('indigo')).resolves.toEqual([]);
  });
});
