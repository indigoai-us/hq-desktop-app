import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from './projects-model';
import {
  dedupeProjects,
  loadLocalProjects,
  projectIdentity,
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
