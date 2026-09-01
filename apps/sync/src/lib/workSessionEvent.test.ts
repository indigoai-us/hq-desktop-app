import { describe, it, expect } from 'vitest';
import { parseWorkSessionEvent } from './workSessionEvent';

const DONE_SAMPLE =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"T-002 marked done on the board"}}';

function sessionBody(
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    v: 1,
    kind: 'work-session-event',
    threadId: 'work-desktop-dogfood:T-002',
    event,
    ...extra,
  });
}

describe('parseWorkSessionEvent', () => {
  it('parses a valid done event', () => {
    expect(parseWorkSessionEvent(DONE_SAMPLE)).toEqual({
      kind: 'done',
      actor: 'Stefan Johnson',
      storyId: 'T-002',
      title: 'T-002 marked done on the board',
      verb: 'marked done',
      at: '2026-08-28T15:14:05.854Z',
      storyTitle: null,
      summary: 'T-002 marked done on the board',
      doneCriteria: null,
      branch: null,
      runtime: null,
    });
  });

  it('maps start and claim to started', () => {
    expect(parseWorkSessionEvent(sessionBody({ kind: 'start', by: 'Ada' }))).toMatchObject({
      kind: 'start',
      actor: 'Ada',
      verb: 'started',
      storyId: 'T-002',
    });
    expect(parseWorkSessionEvent(sessionBody({ kind: 'claim', by: 'Ada' }))).toMatchObject({
      kind: 'claim',
      actor: 'Ada',
      verb: 'started',
      storyId: 'T-002',
    });
  });

  it('maps blocked to is blocked on', () => {
    expect(parseWorkSessionEvent(sessionBody({ kind: 'blocked', by: 'Ada' }))).toMatchObject({
      kind: 'blocked',
      actor: 'Ada',
      verb: 'is blocked on',
      storyId: 'T-002',
    });
  });

  it('reads storyId and storyTitle from an escaped JSON payload string', () => {
    const body = sessionBody(
      { kind: 'start', by: 'Ada' },
      {
        payload: JSON.stringify({
          storyId: 'US-001',
          storyTitle: 'Fix the version menu',
        }),
      },
    );
    expect(parseWorkSessionEvent(body)).toMatchObject({
      storyId: 'US-001',
      title: 'Fix the version menu',
      verb: 'started',
    });
  });

  it('reads an escaped payload nested on the event object', () => {
    const body = sessionBody({
      kind: 'start',
      by: 'Ada',
      payload: JSON.stringify({ storyId: 'T-010', storyTitle: 'Nested payload' }),
    });
    expect(parseWorkSessionEvent(body)).toMatchObject({
      storyId: 'T-010',
      title: 'Nested payload',
    });
  });

  it('reads storyId from a payload object', () => {
    const body = sessionBody(
      { kind: 'done', by: 'Ada' },
      { payload: { storyId: 'T-007', storyTitle: 'Object payload' } },
    );
    expect(parseWorkSessionEvent(body)).toMatchObject({
      storyId: 'T-007',
      title: 'Object payload',
    });
  });

  it('ignores a non-JSON payload string and still extracts storyId from threadId', () => {
    expect(
      parseWorkSessionEvent(sessionBody({ kind: 'start', by: 'Ada' }, { payload: 'not-json' }))
        ?.storyId,
    ).toBe('T-002');
  });

  it('extracts storyId from the threadId suffix when payload has no storyId', () => {
    const body = sessionBody(
      { kind: 'start', by: 'Ada', summary: 'kicked off' },
      { threadId: 'work-desktop-dogfood:US-014' },
    );
    expect(parseWorkSessionEvent(body)).toMatchObject({
      storyId: 'US-014',
      title: 'kicked off',
    });
  });

  it('returns null for a non-JSON body', () => {
    expect(parseWorkSessionEvent('T-002 marked done on the board')).toBeNull();
    expect(parseWorkSessionEvent('')).toBeNull();
  });

  it('returns null for JSON with the wrong kind', () => {
    expect(
      parseWorkSessionEvent(
        JSON.stringify({ kind: 'channel-notice', event: { kind: 'done', by: 'Ada' } }),
      ),
    ).toBeNull();
  });

  it('returns null for malformed or truncated JSON without throwing', () => {
    expect(parseWorkSessionEvent('{"v":1,"kind":"work-session-event"')).toBeNull();
    expect(parseWorkSessionEvent('{')).toBeNull();
    expect(parseWorkSessionEvent('{"kind":')).toBeNull();
  });

  it('returns null when event is missing', () => {
    expect(
      parseWorkSessionEvent(JSON.stringify({ kind: 'work-session-event', threadId: 'x:T-002' })),
    ).toBeNull();
  });

  it('returns null for unknown event kinds', () => {
    expect(parseWorkSessionEvent(sessionBody({ kind: 'pause', by: 'Ada' }))).toBeNull();
  });

  it('falls back to Someone when by is missing', () => {
    expect(parseWorkSessionEvent(sessionBody({ kind: 'done' }))).toMatchObject({
      actor: 'Someone',
    });
  });
});
