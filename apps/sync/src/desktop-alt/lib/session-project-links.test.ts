/**
 * The pure rules behind the sidebar's session decoration: which project a
 * row stands for, what the badge says, and the `new?…` route param.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRow } from '@hq/ui';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  conventionalChannelName,
  linkForProject,
  linkForRow,
  newSessionParam,
  projectNameFor,
  projectSlug,
  projectSlugFor,
  rowExtrasFor,
  sessionsBadge,
  type ProjectLink,
} from './session-project-links';

const launch: ProjectLink = {
  project: 'launch',
  projectName: 'Launch Q3',
  projectPath: '/hq/companies/indigo/projects/launch',
  channelId: 'chn_launch',
  channelName: 'p-launch',
  sessions: [
    { sessionId: 's-live', tool: 'claude', phase: 'working', startedAt: '2026-09-02T09:00:00Z' },
    { sessionId: 's-old', tool: 'codex', phase: 'ended', startedAt: '2026-09-01T09:00:00Z' },
  ],
};
const onboarding: ProjectLink = {
  project: 'onboarding-v2',
  projectName: 'Onboarding v2',
  projectPath: '/hq/companies/indigo/projects/onboarding-v2',
  sessions: [{ sessionId: 's-1', tool: 'claude', phase: 'ended', startedAt: '2026-09-01T09:00:00Z' }],
};
const empty: ProjectLink = {
  project: 'quiet',
  projectName: 'Quiet',
  projectPath: '/hq/companies/indigo/projects/quiet',
  sessions: [],
};
const links = [launch, onboarding, empty];

function row(overrides: Partial<ConversationRow>): ConversationRow {
  return {
    id: 'ch:x',
    kind: 'channel',
    title: 'x',
    companyUid: 'cmp_1',
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...overrides,
  };
}

describe('project keys', () => {
  it('the slug is the directory leaf, on either separator', () => {
    expect(projectSlug('/hq/companies/indigo/projects/launch')).toBe('launch');
    expect(projectSlug('/hq/companies/indigo/projects/launch/')).toBe('launch');
    expect(projectSlug('C:\\hq\\projects\\Launch Q3')).toBe('Launch Q3');
    expect(projectSlug('')).toBe('');
  });

  it('maps the composer pick (a name) to its slug and back', () => {
    const projects = [
      {
        name: 'Launch Q3',
        description: '',
        branchName: null,
        path: '/hq/companies/indigo/projects/launch',
        storyCounts: { total: 0, done: 0 },
        updatedAt: null,
      },
    ];
    expect(projectSlugFor(projects, 'Launch Q3')).toBe('launch');
    // An unknown name is passed through: the backend join accepts names too.
    expect(projectSlugFor(projects, 'Mystery')).toBe('Mystery');
    expect(projectSlugFor(projects, null)).toBeNull();
    expect(projectSlugFor(projects, '  ')).toBeNull();
    expect(projectNameFor(projects, 'launch')).toBe('Launch Q3');
    expect(projectNameFor(projects, 'LAUNCH Q3')).toBe('Launch Q3');
    expect(projectNameFor(projects, 'nope')).toBeNull();
    expect(projectNameFor(projects, null)).toBeNull();
  });

  it('names the conventional channel exactly like the Rust share flow', () => {
    expect(conventionalChannelName('launch')).toBe('p-launch');
    expect(conventionalChannelName('Launch Q3')).toBe('p-launch-q3');
    expect(conventionalChannelName('--')).toBe('');
  });
});

describe('linkForRow', () => {
  it('resolves by channel id first', () => {
    expect(linkForRow(row({ channelId: 'chn_launch', title: 'renamed' }), links)).toBe(launch);
  });

  it('falls back to the hq-pro projectId, then to the p-<slug> title', () => {
    expect(linkForRow(row({ channelId: 'chn_other', projectId: 'onboarding-v2' }), links)).toBe(
      onboarding,
    );
    expect(linkForRow(row({ channelId: 'chn_other', projectId: 'Onboarding v2' }), links)).toBe(
      onboarding,
    );
    expect(linkForRow(row({ channelId: 'chn_other', title: '#P-Onboarding-v2' }), links)).toBe(
      onboarding,
    );
  });

  it('never links DMs, groups, or channels that are not project channels', () => {
    expect(linkForRow(row({ kind: 'dm', title: 'p-launch' }), links)).toBeNull();
    expect(linkForRow(row({ kind: 'group', title: 'p-launch' }), links)).toBeNull();
    expect(linkForRow(row({ channelId: 'chn_general', title: 'general' }), links)).toBeNull();
    expect(linkForRow(row({ channelId: 'chn_x', title: 'p-unknown' }), links)).toBeNull();
  });

  it('finds the strip pill link by slug or name', () => {
    expect(linkForProject(links, 'launch')).toBe(launch);
    expect(linkForProject(links, 'Launch Q3')).toBe(launch);
    expect(linkForProject(links, 'nope')).toBeNull();
    expect(linkForProject(links, null)).toBeNull();
  });
});

describe('badge + extras', () => {
  it('says how many are live, else how many there were, else nothing', () => {
    expect(sessionsBadge(launch)).toBe('1 live');
    expect(sessionsBadge(onboarding)).toBe('1 session');
    expect(sessionsBadge({ ...onboarding, sessions: [...onboarding.sessions, ...onboarding.sessions] })).toBe(
      '2 sessions',
    );
    expect(sessionsBadge(empty)).toBeNull();
  });

  it('decorates only project rows; the hover card needs sessions, the action does not', () => {
    const card = (() => null) as unknown as NonNullable<
      ReturnType<typeof rowExtrasFor>
    >['hoverCard'];
    const chosen: ProjectLink[] = [];
    const onnew = (link: ProjectLink) => chosen.push(link);

    const decorated = rowExtrasFor(row({ channelId: 'chn_launch' }), links, card, onnew);
    expect(decorated?.badge).toBe('1 live');
    expect(decorated?.hoverCard).toBe(card);
    expect(decorated?.actions?.map((a) => [a.id, a.label])).toEqual([['new-session', 'New session']]);
    decorated?.actions?.[0]?.onselect();
    expect(chosen).toEqual([launch]);

    const quiet = rowExtrasFor(row({ channelId: 'chn_q', title: 'p-quiet' }), links, card, onnew);
    expect(quiet?.badge).toBeNull();
    expect(quiet?.hoverCard).toBeNull();
    expect(quiet?.actions).toHaveLength(1);

    expect(rowExtrasFor(row({ channelId: 'chn_general', title: 'general' }), links, card, onnew)).toBeNull();
  });
});

describe('newSessionParam', () => {
  it('encodes company and project as a query the page can parse', () => {
    expect(newSessionParam('indigo', 'launch')).toBe('new?company=indigo&project=launch');
    expect(newSessionParam('indigo', null)).toBe('new?company=indigo');
    expect(newSessionParam('indigo', '  ')).toBe('new?company=indigo');
    expect(newSessionParam('indigo', 'Launch Q3')).toBe('new?company=indigo&project=Launch+Q3');
  });
});
