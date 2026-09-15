import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Regression — the company work-system surfaces must show real PRD data or an
 * honest placeholder, never fabricated values.
 *
 * Context: Tasks/Projects/Goals invented assignees, completion times, start
 * weekdays, target dates, and "agent proposed N projects" from row index / a
 * string hash of the story or project id. prd.json carries no assignee/owner
 * field and no per-story/target dates — only Project.createdAt/updatedAt are
 * real — so any of those is a made-up value presented as fact. This locks the
 * fabrications out: derive from real fields and recorded Git history or keep
 * missing people visually quiet.
 *
 * company-detail-desktop-ia: cross-project Tasks page removed; honesty for
 * stories is asserted on Projects + ProjectDetailView instead.
 */
describe('company surfaces show real data, not fabrications', () => {
  const projects = readRepoFile('../../packages/ui/src/projects/CompanyProjectsPage.svelte');
  const projectDetail = readRepoFile('../../packages/ui/src/projects/ProjectDetailView.svelte');
  const goals = readRepoFile('../../packages/ui/src/projects/CompanyGoalsPage.svelte');

  it('Projects uses recorded responsibility without inventing an owner', () => {
    // @hq/ui is prettier-formatted with double quotes; match either style so
    // this guards the call, not the formatter.
    expect(projects).toMatch(/responsiblePerson\(project\.provenance, ['"]project['"]\)/);
    expect(projects).not.toContain('ownerLabel={leadLabel(project)}');
    expect(projects).not.toContain("return 'Agent'");
    expect(projects).not.toContain('projectIndex');
  });

  it('Projects derives "started" from the real createdAt, not a hashed weekday', () => {
    expect(projects).not.toContain('startedDay');
    expect(projects).not.toContain("'Wed'"); // weekday-hash table
    expect(projects).toContain('project.createdAt');
    expect(projects).toContain('formatProjectDate');
    expect(projects).not.toMatch(/Jun \$\{day\}/); // hashed target date
  });

  it('Project detail does not invent story completion times', () => {
    expect(projectDetail).not.toContain('h ago');
    expect(projectDetail).not.toContain('projectIndex');
  });

  it('Goals does not claim a fabricated agent proposal count', () => {
    expect(goals).not.toContain('agent proposed');
  });
});
