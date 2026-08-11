import { describe, expect, it } from 'vitest';
import {
  goalLinkRef,
  goalLinkedProjects,
  isProjectLinkedToGoal,
  normalizeGoalLinkId,
  objectiveLinkIds,
  projectLinkTokens,
} from './goal-links';
import type { Objective } from './local-projects';
import type { Project } from './projects-model';

function objective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 'obj-1',
    title: 'Goal',
    description: '',
    status: 'on-track',
    timeframe: '2026',
    owner: null,
    keyResults: [],
    initiativeIds: [],
    linearInitiativeId: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'hq-desktop-v2',
    description: '',
    company: 'indigo',
    status: 'active',
    prdPath: 'companies/indigo/projects/hq-desktop-v2/prd.json',
    storiesTotal: 0,
    storiesComplete: 0,
    ...overrides,
  } as Project;
}

describe('goal-links shared association helper (US-005)', () => {
  it('normalizes ids tolerantly', () => {
    expect(normalizeGoalLinkId('HQ Desktop_V2!')).toBe('hqdesktopv2');
    expect(normalizeGoalLinkId(null)).toBe('');
  });

  it('collects objective link ids from initiativeIds, linear id, and own id', () => {
    const ids = objectiveLinkIds(
      objective({
        id: 'obj-1',
        initiativeIds: ['proj-a', ''],
        linearInitiativeId: 'LIN-9',
      }),
    );
    expect(ids).toEqual(new Set(['proja', 'lin9', 'obj1']));
  });

  it('matches a project through any identity token', () => {
    const goal = objective({ initiativeIds: ['hq-desktop-v2'] });
    expect(isProjectLinkedToGoal(goal, project())).toBe(true);
    expect(isProjectLinkedToGoal(goal, project({ id: 'other', prdPath: 'companies/indigo/projects/other/prd.json' }))).toBe(
      false,
    );
    // Matches via the prd directory name even when id differs.
    expect(
      projectLinkTokens(
        project({ id: 'x', prdPath: 'companies/indigo/projects/hq-desktop-v2/prd.json' }),
      ),
    ).toContain('hqdesktopv2');
  });

  it('goalLinkedProjects returns only linked projects and nothing for empty ids', () => {
    const goal = objective({ id: '', initiativeIds: [], linearInitiativeId: null });
    expect(goalLinkedProjects(goal, [project()])).toEqual([]);

    const linkedGoal = objective({ initiativeIds: ['hq-desktop-v2'] });
    const other = project({ id: 'other', prdPath: 'companies/indigo/projects/other/prd.json' });
    expect(goalLinkedProjects(linkedGoal, [project(), other]).map((p) => p.id)).toEqual([
      'hq-desktop-v2',
    ]);
  });

  it('a written goalLinkRef round-trips through the matcher', () => {
    const target = project();
    const ref = goalLinkRef(target);
    expect(ref).toBe('hq-desktop-v2');
    const goal = objective({ initiativeIds: [ref] });
    expect(isProjectLinkedToGoal(goal, target)).toBe(true);
  });

  it('goalLinkRef falls back to the prd directory name and never emits a path', () => {
    const ref = goalLinkRef(
      project({ id: '', prdPath: 'companies/indigo/projects/dir-name/prd.json' }),
    );
    expect(ref).toBe('dir-name');
    expect(ref).not.toContain('/');
  });
});
