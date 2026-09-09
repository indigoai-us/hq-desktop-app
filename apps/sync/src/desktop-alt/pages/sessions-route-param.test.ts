import { describe, expect, it } from 'vitest';

import {
  encodeHistorySessionParam,
  encodeSharedSessionParam,
  parseSessionsParam,
  sessionDraftStorageKey,
  sessionNavigateMode,
  sessionRestorePath,
} from './sessions-route-param';

describe('parseSessionsParam', () => {
  it('reads a bare param as a session id, and nothing as the empty page', () => {
    expect(parseSessionsParam('abc-123')).toEqual({ kind: 'session', sessionId: 'abc-123' });
    expect(parseSessionsParam('  abc ')).toEqual({ kind: 'session', sessionId: 'abc' });
    expect(parseSessionsParam(null)).toEqual({ kind: 'empty' });
    expect(parseSessionsParam(undefined)).toEqual({ kind: 'empty' });
    expect(parseSessionsParam('   ')).toEqual({ kind: 'empty' });
  });

  it('decodes a `new?…` param into a pre-bound fresh chat', () => {
    expect(parseSessionsParam('new?company=indigo&project=launch')).toEqual({
      kind: 'new',
      company: 'indigo',
      project: 'launch',
    });
    expect(parseSessionsParam('new?company=indigo')).toEqual({
      kind: 'new',
      company: 'indigo',
      project: null,
    });
    // URL encoding survives the round trip (`newSessionParam` uses it).
    expect(parseSessionsParam('new?company=indigo&project=Launch+Q3')).toEqual({
      kind: 'new',
      company: 'indigo',
      project: 'Launch Q3',
    });
    expect(parseSessionsParam('new?project=&company=')).toEqual({
      kind: 'new',
      company: null,
      project: null,
    });
    expect(parseSessionsParam('new')).toEqual({ kind: 'new', company: null, project: null });
    expect(parseSessionsParam('new?draft=abc-1')).toEqual({
      kind: 'new',
      company: null,
      project: null,
    });
  });

  it('never mistakes a session id that merely starts with "new" for a route', () => {
    expect(parseSessionsParam('newer-session')).toEqual({
      kind: 'session',
      sessionId: 'newer-session',
    });
  });

  it('decodes provider history metadata for a nested project session', () => {
    expect(
      parseSessionsParam(
        'history?id=native-1&tool=codex&company=indigo&project=hq-agent-workspace&title=Test+session&startedAt=2026-09-04T00%3A13%3A26Z',
      ),
    ).toEqual({
      kind: 'history',
      sessionId: 'native-1',
      tool: 'codex',
      company: 'indigo',
      project: 'hq-agent-workspace',
      title: 'Test session',
      startedAt: '2026-09-04T00:13:26Z',
    });
  });

  it('classifies restore paths without start/send and keeps draft identity out of live ids', () => {
    expect(sessionRestorePath({ kind: 'empty' })).toBe('none');
    expect(sessionRestorePath({ kind: 'new', company: null, project: null })).toBe('none');
    expect(sessionRestorePath({ kind: 'session', sessionId: 'ses_live' })).toBe('open');
    expect(
      sessionRestorePath({
        kind: 'history',
        sessionId: 'ses_hist',
        tool: 'claude',
        company: 'indigo',
        project: 'launch',
        title: '',
        startedAt: '',
      }),
    ).toBe('openHistory');
    expect(
      sessionRestorePath({ kind: 'shared', sessionId: 'ses_share', channelId: 'chn_a' }),
    ).toBe('shared-view');
    expect(sessionNavigateMode({ replace: true })).toBe('replace');
    expect(sessionNavigateMode()).toBe('push');
    expect(sessionDraftStorageKey('new?draft=abc')).toBe('sessions:new?draft=abc');
    expect(sessionDraftStorageKey('ses_live')).toBeNull();
    expect(sessionDraftStorageKey('history?id=h&tool=claude')).toBeNull();
    expect(encodeHistorySessionParam({ id: 'h1', tool: 'codex', company: 'indigo' })).toBe(
      'history?id=h1&tool=codex&company=indigo',
    );
    expect(encodeSharedSessionParam('s1', 'chn_a')).toBe('shared?id=s1&channel=chn_a');
  });
});
