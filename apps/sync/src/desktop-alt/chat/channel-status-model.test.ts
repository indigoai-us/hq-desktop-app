import { describe, expect, it } from 'vitest';
import {
  buildChannelStatusModel,
  computeStoryRollup,
  extractStoryId,
  firstOpenStoryId,
  liveAgentRowFromSession,
  projectChannelHeaderTitle,
  resolveMemberPillCount,
  resolvePreviewUrl,
  resolveRepoPath,
} from './channel-status-model';

describe('channel-status-model (US-005 status popover)', () => {
  it('extracts US-xxx story ids from free text', () => {
    expect(extractStoryId('working on US-003 now')).toBe('US-003');
    expect(extractStoryId('/tmp/work/US_012/foo')).toBe('US-012');
    expect(extractStoryId('no story here')).toBeNull();
  });

  it('computes story rollup from prd passes', () => {
    const rollup = computeStoryRollup(
      { id: 'p', storiesTotal: 99, storiesComplete: 1 },
      {
        userStories: [
          { id: 'US-001', passes: true },
          { id: 'US-002', passes: true },
          { id: 'US-003', passes: false },
          { id: 'US-004', passes: false },
        ],
      },
    );
    expect(rollup).toEqual({
      complete: 2,
      total: 4,
      label: 'stories 2/4',
      percent: 50,
    });
  });

  it('falls back to project story counts when prd has no stories', () => {
    const rollup = computeStoryRollup(
      { id: 'p', storiesTotal: 10, storiesComplete: 3 },
      null,
    );
    expect(rollup.label).toBe('stories 3/10');
    expect(rollup.percent).toBe(30);
  });

  it('resolves repo path and preview url from prd + metadata', () => {
    expect(
      resolveRepoPath({
        prdPath: 'companies/indigo/projects/flagship/prd.json',
      }),
    ).toBe('companies/indigo/projects/flagship');
    expect(
      resolveRepoPath({
        repoPath: '/Users/corey/repo',
        prdPath: 'companies/x/projects/y/prd.json',
      }),
    ).toBe('/Users/corey/repo');
    expect(
      resolvePreviewUrl({
        metadata: { previewUrl: 'https://preview.example/app' },
      }),
    ).toBe('https://preview.example/app');
    expect(resolvePreviewUrl({ metadata: {} })).toBeNull();
  });

  it('builds live agent row label with story + progress', () => {
    const rollup = { complete: 2, total: 5, label: 'stories 2/5', percent: 40 };
    const row = liveAgentRowFromSession(
      {
        project: 'hq-desktop-app',
        company: 'indigo',
        cwd: '/work/US-005/src',
        status: 'running',
        tool: 'claude',
        model: 'opus',
      },
      rollup,
      'US-001',
    );
    expect(row.storyId).toBe('US-005');
    expect(row.progressPercent).toBe(40);
    expect(row.label).toBe('Agent running · US-005 · 40%');
  });

  it('picks first open story id from prd', () => {
    expect(
      firstOpenStoryId({
        userStories: [
          { id: 'US-001', passes: true },
          { id: 'US-002', passes: false },
        ],
      }),
    ).toBe('US-002');
  });

  it('builds full status model with project block + members + agents', () => {
    const model = buildChannelStatusModel({
      project: {
        id: 'hq-desktop-app',
        title: 'HQ Desktop',
        name: 'HQ Desktop',
        company: 'indigo',
        prdPath: 'companies/indigo/projects/hq-desktop-app/prd.json',
        storiesTotal: 4,
        storiesComplete: 1,
      },
      companyLabel: 'Indigo',
      prd: {
        branchName: 'feature/hq-desktop-v2-chat',
        prdPath: 'companies/indigo/projects/hq-desktop-app/prd.json',
        metadata: { previewUrl: 'https://preview.example/hq' },
        userStories: [
          { id: 'US-001', passes: true },
          { id: 'US-002', passes: false },
          { id: 'US-003', passes: false },
          { id: 'US-004', passes: false },
        ],
      },
      sessions: [
        {
          project: 'hq-desktop-app',
          company: 'indigo',
          cwd: '/Users/x/hq-desktop-app',
          status: 'running',
          tool: 'claude',
          model: 'opus',
          startedAt: '2026-08-11T10:00:00Z',
        },
        {
          project: 'other-thing',
          company: 'indigo',
          cwd: '/tmp/other',
          status: 'running',
          tool: 'codex',
        },
      ],
      members: [
        {
          personUid: 'prs_human',
          displayName: 'Corey',
          role: 'owner',
        },
        {
          personUid: 'agent:fleet-1',
          displayName: 'Fleet Bot',
          role: 'agent',
          isAgent: true,
        },
      ],
    });

    expect(model.stories.label).toBe('stories 1/4');
    expect(model.project.branch).toBe('feature/hq-desktop-v2-chat');
    expect(model.project.repo).toBe('companies/indigo/projects/hq-desktop-app');
    expect(model.project.previewUrl).toBe('https://preview.example/hq');
    expect(model.liveAgents.length).toBe(1);
    expect(model.liveAgents[0]?.label).toMatch(/^Agent running · US-002 · 25%$/);
    expect(model.members.map((m) => m.displayName)).toEqual(['Corey']);
    expect(model.agents.some((a) => a.displayName === 'Fleet Bot')).toBe(true);
    expect(model.agents.some((a) => a.statusIcon === 'running')).toBe(true);
    expect(model.memberCount).toBe(2);
    expect(model.companyLabel).toBe('Indigo');
  });

  it('formats project channel header title', () => {
    expect(projectChannelHeaderTitle('hq-desktop', 'Indigo')).toBe(
      '# hq-desktop · Indigo · project channel',
    );
    expect(projectChannelHeaderTitle('#launch', null)).toBe(
      '# launch · Company · project channel',
    );
  });

  it('hides preview when no deploy url exists', () => {
    const model = buildChannelStatusModel({
      project: { id: 'p', title: 'P', company: 'c' },
      prd: { branchName: 'main', userStories: [] },
    });
    expect(model.project.previewUrl).toBeNull();
    expect(model.project.branch).toBe('main');
  });
});

describe('resolveMemberPillCount (header pill drift regression)', () => {
  it('adopts the model count after a real roster fetch', () => {
    expect(resolveMemberPillCount(5, { memberCount: 5 }, 6)).toBe(5);
  });

  it('keeps the previous metadata count when the roster fetch was empty (fixture fallback)', () => {
    // Opening + closing the popover with no roster data must NOT drift the
    // pill from the channel-metadata count (6) to the fixture count (5).
    expect(resolveMemberPillCount(0, { memberCount: 5 }, 6)).toBe(6);
  });

  it('stays null when there was never a count and no roster data', () => {
    expect(resolveMemberPillCount(0, { memberCount: 5 }, null)).toBeNull();
  });
});
