/**
 * The pure rules behind the sidebar's session decoration: which project a
 * row stands for, what the badge says, and the `new?…` route param.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRow } from '@hq/ui';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  conventionalChannelName,
  historySessionParam,
  linkForProject,
  linkForSession,
  mergeLocalProjectLinks,
  linkForRow,
  newSessionParam,
  projectNameFor,
  projectSlug,
  projectSlugFor,
  rowExtrasFor,
  sessionsBadge,
  type ProjectLink,
} from './session-project-links';

it.each(['starting', 'working', 'idle', 'needs-you'])('routes %s sessions to live replay, not provider history', (phase) => {
  expect(historySessionParam('indigo', 'launch', {
    sessionId: 'app-owned-id', tool: 'codex', phase,
    startedAt: '2026-09-04T21:55:44Z', title: 'Startup check',
  })).toBe('app-owned-id');
});

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

it('encodes enough durable metadata to open a nested history row directly', () => {
  expect(
    historySessionParam('indigo', 'launch', {
      sessionId: 'native-1',
      tool: 'codex',
      phase: 'ended',
      startedAt: '2026-09-04T00:13:26Z',
      title: 'Test session',
    }),
  ).toBe(
    'history?id=native-1&tool=codex&company=indigo&project=launch&title=Test+session&startedAt=2026-09-04T00%3A13%3A26Z',
  );
});
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
        owner: null,
        lastActivityAt: null,
        status: 'active' as const,
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
  it('keeps explicit session enrollment under its channel and in the header', () => {
    const first = { ...launch, sessions: [{ ...launch.sessions[0], channelId: 'chn_second' }] };
    const second = { ...launch, channelId: 'chn_second', sessions: [] };
    expect(linkForRow(row({ channelId: 'chn_launch' }), [first, second])?.sessions).toEqual([]);
    expect(linkForRow(row({ channelId: 'chn_second' }), [first, second])?.sessions).toHaveLength(1);
    expect(linkForSession([first, second], 's-live', 'launch')?.channelId).toBe('chn_second');
    expect(linkForSession([first, second], 'app-routing-id', 'launch', 's-live')?.channelId).toBe('chn_second');
    expect(linkForRow(row({ channelId: 'chn_unrelated', title: 'p-launch' }), [first])).toBeNull();
  });

  it('preserves both channel identities across local refresh and does not duplicate unbound history', () => {
    const second = { ...launch, channelId: 'chn_second', sessions: [] };
    const local = { ...launch, channelId: undefined, sessions: [
      { ...launch.sessions[0], channelId: 'chn_second' }, launch.sessions[1],
    ] };
    const merged = mergeLocalProjectLinks([local], [launch, second]);
    expect(merged.map(link => link.channelId)).toEqual(['chn_launch', 'chn_second']);
    expect(merged.map(link => link.sessions.map(session => session.sessionId))).toEqual([['s-old'], ['s-live']]);
  });
  it('resolves by channel id first', () => {
    expect(linkForRow(row({ channelId: 'chn_launch', title: 'renamed' }), links)).toBe(launch);
  });

  it('falls back to the hq-pro projectId, then to the p-<slug> title', () => {
    expect(linkForRow(row({ channelId: 'chn_other', projectId: 'onboarding-v2' }), links)).toMatchObject(
      { ...onboarding, channelId: 'chn_other', channelName: expect.any(String) },
    );
    expect(linkForRow(row({ channelId: 'chn_other', projectId: 'Onboarding v2' }), links)).toMatchObject(
      { ...onboarding, channelId: 'chn_other', channelName: expect.any(String) },
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
  it('launches in the clicked channel when a cached project points at another channel', () => {
    const onnew = vi.fn();
    const extras = rowExtrasFor(
      row({ channelId: 'chn_new_project', projectId: 'launch', title: 'Verified project' }),
      links, null, onnew, vi.fn(),
    );
    extras?.actions?.[0].onselect();
    expect(onnew).toHaveBeenCalledWith(expect.objectContaining({
      project: 'launch', channelId: 'chn_new_project', channelName: 'Verified project',
    }));
    expect(launch.channelId).toBe('chn_launch');
  });
  it('says how many are live, else how many there were, else nothing', () => {
    expect(sessionsBadge(launch)).toBe('1 live');
    expect(sessionsBadge(onboarding)).toBe('1');
    expect(sessionsBadge({ ...onboarding, sessions: [...onboarding.sessions, ...onboarding.sessions] })).toBe(
      '2',
    );
    expect(sessionsBadge(empty)).toBeNull();
  });

  it('decorates only project rows; the hover card needs sessions, the action does not', () => {
    const card = (() => null) as unknown as NonNullable<
      ReturnType<typeof rowExtrasFor>
    >['hoverCard'];
    const chosen: ProjectLink[] = [];
    const onnew = (link: ProjectLink) => chosen.push(link);

    const opened: Array<[ProjectLink, string]> = [];
    const decorated = rowExtrasFor(
      row({ channelId: 'chn_launch' }),
      links,
      card,
      onnew,
      (link, session) => opened.push([link, session.sessionId]),
    );
    expect(decorated?.badge).toBe('1 live');
    expect(decorated?.hoverCard).toBe(card);
    expect(decorated?.actions?.map((a) => [a.id, a.label])).toEqual([['new-session', 'New session']]);
    expect(decorated?.childrenExpandedByDefault).toBe(true);
    expect(decorated?.childrenLabel).toBe('Sessions for Launch Q3');
    const selected = rowExtrasFor(row({ channelId: 'chn_launch' }), links, card, onnew, () => {}, 's-old');
    expect(selected?.children?.filter((child) => child.selected).map((child) => child.id)).toEqual(['session:s-old']);
    expect(decorated?.children?.map((child) => ({
      id: child.id,
      label: child.label,
      meta: child.meta,
      status: child.status,
      kind: child.kind,
    }))).toEqual([
      {
        id: 'session:s-live',
        label: 'Claude session',
        meta: 'Working',
        status: 'working',
        kind: 'item',
      },
      {
        id: 'session:s-old',
        label: 'Codex session',
        meta: null,
        status: 'ended',
        kind: 'item',
      },
      {
        id: 'new-session',
        label: 'New session',
        meta: null,
        status: undefined,
        kind: 'action',
      },
    ]);

    decorated?.children?.[0]?.onselect();
    expect(opened).toEqual([[launch, 's-live']]);
    decorated?.actions?.[0]?.onselect();
    expect(chosen).toEqual([launch]);

    const quiet = rowExtrasFor(
      row({ channelId: 'chn_q', title: 'p-quiet' }),
      links,
      card,
      onnew,
      () => {},
    );
    expect(quiet?.badge).toBeNull();
    expect(quiet?.hoverCard).toBeNull();
    expect(quiet?.actions).toHaveLength(1);
    expect(quiet?.childrenExpandedByDefault).toBe(false);
    expect(quiet?.children?.map((child) => child.id)).toEqual(['new-session']);

    expect(
      rowExtrasFor(
        row({ channelId: 'chn_general', title: 'general' }),
        links,
        card,
        onnew,
        () => {},
      ),
    ).toBeNull();
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
