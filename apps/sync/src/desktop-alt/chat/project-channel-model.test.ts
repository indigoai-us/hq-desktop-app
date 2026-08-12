import { describe, expect, it } from 'vitest';
import {
  agentsForProject,
  buildCreateProjectChannelPayload,
  defaultChannelNameFromProject,
  filterProjectPickerRows,
  isProjectChannel,
  mergeInviteUids,
  resolveCompanyUidForProject,
  toProjectPickerRow,
} from './project-channel-model';

describe('project-channel-model (US-005 create flow)', () => {
  it('defaults channel name from project title as a slug', () => {
    expect(
      defaultChannelNameFromProject({
        id: 'in-proj-001',
        title: 'HQ Desktop App',
        name: 'HQ Desktop App',
      }),
    ).toBe('hq-desktop-app');
    expect(
      defaultChannelNameFromProject({
        id: 'x',
        title: '###Launch!!',
        name: '',
      }),
    ).toBe('launch');
  });

  it('maps projects to picker rows', () => {
    const row = toProjectPickerRow({
      id: 'p1',
      title: 'Flagship',
      name: 'Flagship',
      company: 'indigo',
      prdPath: 'companies/indigo/projects/flagship/prd.json',
    });
    expect(row).toMatchObject({
      id: 'p1',
      title: 'Flagship',
      company: 'indigo',
      subtitle: 'indigo',
    });
  });

  it('resolves companyUid from workspace slug', () => {
    const workspaces = [
      { slug: 'personal', cloudUid: null, kind: 'personal' as const },
      { slug: 'indigo', cloudUid: 'cmp_indigo', kind: 'company' as const },
    ];
    expect(resolveCompanyUidForProject('indigo', workspaces)).toBe('cmp_indigo');
    expect(resolveCompanyUidForProject('missing', workspaces)).toBeNull();
    expect(resolveCompanyUidForProject('indigo', [{ slug: 'indigo', cloudUid: '  ' }])).toBeNull();
  });

  it('merges human + agent invite uids without duplicates', () => {
    expect(mergeInviteUids(['prs_a', 'prs_b', 'prs_a'], ['agent:x', 'prs_b'])).toEqual([
      'prs_a',
      'prs_b',
      'agent:x',
    ]);
  });

  it('builds create_channel payload for scope=project', () => {
    const payload = buildCreateProjectChannelPayload({
      name: '  #hq-desktop  ',
      projectId: 'hq-desktop-app',
      companyUid: 'cmp_indigo',
      humanInviteUids: ['prs_a'],
      agentInviteUids: ['agent:claude:cwd'],
    });
    expect(payload).toEqual({
      name: 'hq-desktop',
      scope: 'project',
      companyUid: 'cmp_indigo',
      projectId: 'hq-desktop-app',
      invite: ['prs_a', 'agent:claude:cwd'],
    });
    expect(
      buildCreateProjectChannelPayload({
        name: '',
        projectId: 'p',
        companyUid: 'c',
        humanInviteUids: [],
        agentInviteUids: [],
      }),
    ).toBeNull();
  });

  it('derives agents from sessions matched to the project', () => {
    const agents = agentsForProject(
      {
        id: 'hq-desktop-app',
        name: 'HQ Desktop',
        title: 'HQ Desktop',
        prdPath: 'companies/indigo/projects/hq-desktop-app/prd.json',
        company: 'indigo',
      },
      [
        {
          project: 'hq-desktop-app',
          company: 'indigo',
          cwd: '/Users/x/hq-desktop-app',
          status: 'running',
          tool: 'claude',
          model: 'opus',
        },
        {
          project: 'other',
          company: 'indigo',
          cwd: '/tmp/other',
          status: 'running',
          tool: 'codex',
        },
      ],
      ['agent:assigned-bot'],
    );
    expect(agents.some((a) => a.personUid === 'agent:assigned-bot')).toBe(true);
    expect(agents.some((a) => a.status === 'running' && a.displayName.includes('claude'))).toBe(
      true,
    );
    expect(agents.every((a) => !a.displayName.includes('codex') || a.source === 'assignment')).toBe(
      true,
    );
  });

  it('filters project picker rows by query', () => {
    const rows = [
      toProjectPickerRow({
        id: 'a',
        title: 'Desktop',
        name: 'Desktop',
        company: 'indigo',
        prdPath: '',
      }),
      toProjectPickerRow({
        id: 'b',
        title: 'Mobile',
        name: 'Mobile',
        company: 'acme',
        prdPath: '',
      }),
    ];
    expect(filterProjectPickerRows(rows, 'desk').map((r) => r.id)).toEqual(['a']);
    expect(filterProjectPickerRows(rows, 'acme').map((r) => r.id)).toEqual(['b']);
    expect(filterProjectPickerRows(rows, '').length).toBe(2);
  });

  it('detects project channels by scope or projectId', () => {
    expect(isProjectChannel({ scope: 'project' })).toBe(true);
    expect(isProjectChannel({ scope: 'company', projectId: 'p1' })).toBe(true);
    expect(isProjectChannel({ scope: 'company' })).toBe(false);
    expect(isProjectChannel({ scope: 'personal' })).toBe(false);
  });
});
