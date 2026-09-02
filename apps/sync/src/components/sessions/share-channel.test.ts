/**
 * The pure half of "Share to channel": the draft → payload rules, the
 * preview wording the operator confirms against, and the folding of the
 * per-invite outcomes the backend returns. No DOM, no invoke.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  buildSharePayload,
  channelSlug,
  emptyShareDraft,
  filterChannels,
  filterMembers,
  foldInviteResults,
  hashName,
  inviteSummary,
  memberLabel,
  projectChannelName,
  shareDraftBlocker,
  sharePreviewText,
  shareResultText,
  type PreflightChannel,
  type PreflightMember,
  type ShareDraft,
  type ShareToChannelResult,
} from './share-channel';

const CHANNELS: PreflightChannel[] = [
  { channelId: 'ch_general', name: 'general', kind: 'company' },
  { channelId: 'ch_launch', name: 'p-launch', kind: 'project' },
  { channelId: 'ch_ops', name: 'Ops Room', kind: 'group' },
];

const MEMBERS: PreflightMember[] = [
  { uid: 'usr_ann', displayName: 'Ann Lee', kind: 'human' },
  { uid: 'usr_bob', displayName: 'Bob Ray', kind: 'human' },
  { uid: 'agt_scout', displayName: 'Scout', kind: 'agent' },
];

function draft(overrides: Partial<ShareDraft> = {}): ShareDraft {
  return { ...emptyShareDraft('sess-1', 'indigo'), ...overrides };
}

describe('channelSlug / projectChannelName / hashName', () => {
  it('lowercases, strips a leading #, collapses junk to single dashes', () => {
    expect(channelSlug('#Launch Week!! 2026')).toBe('launch-week-2026');
    expect(channelSlug('  --already-fine--  ')).toBe('already-fine');
    expect(channelSlug('###')).toBe('');
    expect(channelSlug('snake_case ok')).toBe('snake_case-ok');
  });

  it('prefills a project channel as #p-<slug>, from the path when the name is empty', () => {
    expect(projectChannelName({ name: 'Launch Week', path: '/hq/companies/indigo/projects/launch' })).toBe(
      'p-launch-week',
    );
    expect(projectChannelName({ name: '', path: '/hq/projects/Q4 Push' })).toBe('p-q4-push');
    expect(projectChannelName({ name: '', path: '' })).toBe('');
  });

  it('hashName renders one # and never two', () => {
    expect(hashName('general')).toBe('#general');
    expect(hashName('#general')).toBe('#general');
    expect(hashName('')).toBe('');
  });
});

describe('shareDraftBlocker — the first thing to fix', () => {
  it('needs a session, then a company, then a target', () => {
    expect(shareDraftBlocker(draft({ sessionId: '' }))).toBe('No live session to share.');
    expect(shareDraftBlocker(draft({ company: null }))).toBe('Bind this session to a company first.');
    expect(shareDraftBlocker(draft())).toBe('Pick a channel.');
    expect(shareDraftBlocker(draft({ targetKind: 'new' }))).toBe('Name the new channel.');
    expect(shareDraftBlocker(draft({ targetKind: 'new', newName: '#' }))).toBe('Name the new channel.');
  });

  it('is clear once a channel is picked or a new name typed', () => {
    expect(shareDraftBlocker(draft({ channelId: 'ch_general' }))).toBe('');
    expect(shareDraftBlocker(draft({ targetKind: 'new', newName: 'Launch' }))).toBe('');
  });
});

describe('buildSharePayload — the exact session_share_to_channel arguments', () => {
  it('returns null while the draft is blocked', () => {
    expect(buildSharePayload(draft())).toBeNull();
    expect(buildSharePayload(draft({ targetKind: 'new' }))).toBeNull();
  });

  it('builds an existing-channel share with a note and deduped invites', () => {
    expect(
      buildSharePayload(
        draft({
          channelId: 'ch_general',
          inviteUids: ['usr_ann', 'agt_scout', 'usr_ann'],
          note: '  Review the digest  ',
        }),
      ),
    ).toEqual({
      sessionId: 'sess-1',
      company: 'indigo',
      target: { kind: 'existing', channelId: 'ch_general' },
      inviteUids: ['usr_ann', 'agt_scout'],
      includeTranscript: true,
      note: 'Review the digest',
    });
  });

  it('builds a new-channel share with the slugged name and the project path, omitting a blank note', () => {
    const payload = buildSharePayload(
      draft({
        targetKind: 'new',
        newName: '#Launch Week',
        projectPath: '/hq/companies/indigo/projects/launch',
        includeTranscript: false,
        note: '   ',
      }),
    );
    expect(payload).toEqual({
      sessionId: 'sess-1',
      company: 'indigo',
      target: {
        kind: 'new',
        name: 'launch-week',
        projectPath: '/hq/companies/indigo/projects/launch',
      },
      inviteUids: [],
      includeTranscript: false,
    });
    expect(payload).not.toHaveProperty('note');
  });

  it('leaves projectPath off a new channel that was not made from a project', () => {
    const payload = buildSharePayload(draft({ targetKind: 'new', newName: 'adhoc' }));
    expect(payload?.target).toEqual({ kind: 'new', name: 'adhoc' });
  });

  it('never sends a stale channelId once the target is a new channel', () => {
    const payload = buildSharePayload(
      draft({ targetKind: 'new', newName: 'fresh', channelId: 'ch_general' }),
    );
    expect(payload?.target).toEqual({ kind: 'new', name: 'fresh' });
  });
});

describe('sharePreviewText — what the Share button will do', () => {
  it('names the existing channel and counts the invites by kind', () => {
    expect(sharePreviewText(draft({ channelId: 'ch_general' }), CHANNELS, MEMBERS)).toBe(
      'Will post to #general',
    );
    expect(
      sharePreviewText(
        draft({ channelId: 'ch_general', inviteUids: ['usr_ann', 'usr_bob'] }),
        CHANNELS,
        MEMBERS,
      ),
    ).toBe('Will post to #general and invite 2 people');
    expect(
      sharePreviewText(
        draft({ channelId: 'ch_ops', inviteUids: ['usr_ann', 'agt_scout'] }),
        CHANNELS,
        MEMBERS,
      ),
    ).toBe('Will post to #Ops Room and invite 1 person and 1 agent');
  });

  it('says "create" for a new channel and "a note" when the digest is off', () => {
    expect(
      sharePreviewText(draft({ targetKind: 'new', newName: 'Launch Week' }), CHANNELS, MEMBERS),
    ).toBe('Will create #launch-week');
    expect(
      sharePreviewText(draft({ channelId: 'ch_general', includeTranscript: false }), CHANNELS, MEMBERS),
    ).toBe('Will post a note to #general');
    expect(
      sharePreviewText(
        draft({ targetKind: 'new', newName: 'x', includeTranscript: false, inviteUids: ['usr_ann'] }),
        CHANNELS,
        MEMBERS,
      ),
    ).toBe('Will create #x and post a note and invite 1 person');
  });

  it('shows the blocker instead of a promise it cannot keep', () => {
    expect(sharePreviewText(draft(), CHANNELS, MEMBERS)).toBe('Pick a channel.');
  });

  it('inviteSummary counts a uid the preflight did not list as a person', () => {
    expect(inviteSummary(['usr_zed'], MEMBERS)).toBe('1 person');
    expect(inviteSummary([], MEMBERS)).toBe('');
  });
});

describe('results', () => {
  const result: ShareToChannelResult = {
    channelId: 'ch_general',
    channelName: 'general',
    created: false,
    invited: [
      { uid: 'usr_ann', ok: true },
      { uid: 'usr_bob', ok: false, error: 'not a member of indigo' },
      { uid: 'agt_scout', ok: false },
    ],
    postedEventId: 'evt_1',
    digestChars: 1200,
  };

  it('folds invites into a count and a named failure list', () => {
    expect(foldInviteResults(result.invited)).toEqual({
      ok: 1,
      failed: [
        { uid: 'usr_bob', error: 'not a member of indigo' },
        { uid: 'agt_scout', error: 'invite failed' },
      ],
    });
  });

  it('writes the inline result line', () => {
    expect(shareResultText(result)).toBe('Shared to #general · 1 invited · 2 invites failed');
    expect(
      shareResultText({ ...result, created: true, channelName: 'p-launch', invited: [{ uid: 'a', ok: true }] }),
    ).toBe('Created and shared to #p-launch · 1 invited');
    expect(shareResultText({ ...result, invited: [] })).toBe('Shared to #general');
  });

  it('labels a member by name, falling back to the uid', () => {
    expect(memberLabel('usr_ann', MEMBERS)).toBe('Ann Lee');
    expect(memberLabel('usr_nobody', MEMBERS)).toBe('usr_nobody');
  });
});

describe('search', () => {
  it('filters channels by name, ignoring case and a typed #', () => {
    expect(filterChannels(CHANNELS, '').map((c) => c.channelId)).toEqual([
      'ch_general',
      'ch_launch',
      'ch_ops',
    ]);
    expect(filterChannels(CHANNELS, '#GEN').map((c) => c.channelId)).toEqual(['ch_general']);
    expect(filterChannels(CHANNELS, 'room').map((c) => c.channelId)).toEqual(['ch_ops']);
  });

  it('filters members by name or uid and hides the already-picked', () => {
    expect(filterMembers(MEMBERS, 'ann').map((m) => m.uid)).toEqual(['usr_ann']);
    expect(filterMembers(MEMBERS, 'agt_').map((m) => m.uid)).toEqual(['agt_scout']);
    expect(filterMembers(MEMBERS, '', ['usr_ann']).map((m) => m.uid)).toEqual(['usr_bob', 'agt_scout']);
  });
});
