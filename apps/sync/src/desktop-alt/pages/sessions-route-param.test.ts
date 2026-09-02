import { describe, expect, it } from 'vitest';

import { parseSessionsParam } from './sessions-route-param';

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
  });

  it('never mistakes a session id that merely starts with "new" for a route', () => {
    expect(parseSessionsParam('newer-session')).toEqual({
      kind: 'session',
      sessionId: 'newer-session',
    });
  });
});
