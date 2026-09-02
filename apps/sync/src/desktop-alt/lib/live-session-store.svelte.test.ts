// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../components/sessions/session-events';

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const unlistened = vi.hoisted(() => [] as string[]);

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => {
      unlistened.push(name);
      handlers.delete(name);
    });
  }),
}));

import {
  AGENT_SESSION_EVENT,
  AGENT_SESSION_NEEDS_YOU,
  AGENT_SESSION_PHASE,
  liveSessionStore,
  resetLiveSessionStore,
  type SessionSummary,
} from './live-session-store.svelte';

const SESSION = 'session-1';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: SESSION,
    tool: 'claude',
    phase: 'idle',
    company: 'indigo',
    model: 'opus',
    cwd: '/Users/x/HQ',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    lastSeq: 0,
    pendingCount: 0,
    ...overrides,
  };
}

const started: SessionEvent = {
  kind: 'started',
  sessionId: SESSION,
  tool: 'claude',
  model: 'opus',
  cwd: '/Users/x/HQ',
  tools: ['Bash'],
  commands: [{ name: 'handoff', description: 'End the session' }],
};

/** Replay pages, keyed by the `sinceSeq` the store will ask for. */
type ReplayPage = { events: [number, SessionEvent][]; nextSeq: number; truncated: boolean };

function mockBackend(pages: Record<number, ReplayPage>, list: SessionSummary[] = [summary()]) {
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'agent_session_list') return Promise.resolve(list);
    if (command === 'agent_session_replay') {
      const since = args?.sinceSeq as number;
      const page = pages[since];
      if (!page) throw new Error(`Unexpected replay sinceSeq=${since}`);
      return Promise.resolve(page);
    }
    return Promise.resolve(undefined);
  });
}

function emit(name: string, payload: unknown) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No listener registered for ${name}`);
  handler({ payload });
}

beforeEach(() => {
  resetLiveSessionStore();
  handlers.clear();
  unlistened.length = 0;
  invoke.mockReset();
});

afterEach(() => {
  resetLiveSessionStore();
});

describe('liveSessionStore.open', () => {
  it('replays the whole transcript, then folds live events on top of it', async () => {
    mockBackend({
      0: { events: [[0, started]], nextSeq: 1, truncated: false },
    });

    await liveSessionStore.open(SESSION);

    expect(invoke).toHaveBeenCalledWith('agent_session_replay', {
      sessionId: SESSION,
      sinceSeq: 0,
    });
    expect(liveSessionStore.events).toHaveLength(1);
    expect(liveSessionStore.nextSeq).toBe(1);

    emit(AGENT_SESSION_EVENT, {
      sessionId: SESSION,
      seq: 1,
      event: { kind: 'assistantMessage', text: 'on it' } satisfies SessionEvent,
    });

    expect(liveSessionStore.events).toHaveLength(2);
    expect(liveSessionStore.nextSeq).toBe(2);
    // The fold is what the transcript renders: the started system line plus the
    // assistant's own message row.
    expect(liveSessionStore.transcript.messages.map((m) => m.body)).toEqual([
      expect.stringContaining('Started claude'),
      'on it',
    ]);
  });

  it('carries the started event’s slash commands', async () => {
    mockBackend({ 0: { events: [[0, started]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);
    expect(liveSessionStore.startedCommands.map((c) => c.name)).toEqual(['handoff']);
  });

  it('ignores an event for a session it does not have open', async () => {
    mockBackend({ 0: { events: [[0, started]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);

    emit(AGENT_SESSION_EVENT, {
      sessionId: 'someone-else',
      seq: 0,
      event: { kind: 'assistantMessage', text: 'not mine' } satisfies SessionEvent,
    });

    expect(liveSessionStore.events).toHaveLength(1);
  });

  it('drops a duplicate event rather than folding it twice', async () => {
    mockBackend({ 0: { events: [[0, started]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);

    emit(AGENT_SESSION_EVENT, { sessionId: SESSION, seq: 0, event: started });

    expect(liveSessionStore.events).toHaveLength(1);
    expect(liveSessionStore.nextSeq).toBe(1);
  });
});

describe('liveSessionStore seq gaps', () => {
  it('re-replays from the last contiguous seq instead of rendering a hole', async () => {
    const missed: SessionEvent = { kind: 'assistantMessage', text: 'missed' };
    const arrived: SessionEvent = { kind: 'assistantMessage', text: 'arrived' };
    mockBackend({
      0: { events: [[0, started]], nextSeq: 1, truncated: false },
      1: {
        events: [
          [1, missed],
          [2, arrived],
        ],
        nextSeq: 3,
        truncated: false,
      },
    });

    await liveSessionStore.open(SESSION);
    invoke.mockClear();

    // seq 2 arrives while the store is still expecting seq 1.
    emit(AGENT_SESSION_EVENT, { sessionId: SESSION, seq: 2, event: arrived });
    await vi.waitFor(() => expect(liveSessionStore.nextSeq).toBe(3));

    expect(invoke).toHaveBeenCalledWith('agent_session_replay', {
      sessionId: SESSION,
      sinceSeq: 1,
    });
    // Both the missed event and the one that exposed the gap are present, once.
    expect(liveSessionStore.transcript.messages.map((m) => m.body)).toEqual([
      expect.stringContaining('Started claude'),
      'missed',
      'arrived',
    ]);
  });
});

describe('liveSessionStore phase + needs-you', () => {
  it('updates the phase and refreshes the session list on a phase event', async () => {
    mockBackend({ 0: { events: [], nextSeq: 0, truncated: false } });
    await liveSessionStore.open(SESSION);
    expect(liveSessionStore.phase).toBe('idle');

    invoke.mockClear();
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_list') {
        return Promise.resolve([summary({ phase: 'working' })]);
      }
      return Promise.resolve(undefined);
    });

    emit(AGENT_SESSION_PHASE, { sessionId: SESSION, from: 'idle', to: 'working' });

    expect(liveSessionStore.phase).toBe('working');
    await vi.waitFor(() => expect(liveSessionStore.sessions[0]?.phase).toBe('working'));
    expect(invoke).toHaveBeenCalledWith('agent_session_list');
  });

  it('records the needs-you notice', async () => {
    mockBackend({ 0: { events: [], nextSeq: 0, truncated: false } });
    await liveSessionStore.open(SESSION);

    emit(AGENT_SESSION_NEEDS_YOU, {
      sessionId: SESSION,
      requestId: 'req-1',
      reason: 'permission',
      summary: 'Bash',
    });

    expect(liveSessionStore.needsYou).toEqual({
      sessionId: SESSION,
      requestId: 'req-1',
      reason: 'permission',
      summary: 'Bash',
    });
  });
});

describe('liveSessionStore decisions', () => {
  const permission: SessionEvent = {
    kind: 'permissionRequest',
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    suggestions: [],
  };

  it('sends the exact respond-permission payload the backend expects', async () => {
    mockBackend({ 0: { events: [[0, permission]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);
    expect(liveSessionStore.pending).toHaveLength(1);

    invoke.mockClear();
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.respondPermission('req-1', { kind: 'deny', message: 'not that' });

    expect(invoke).toHaveBeenCalledWith('agent_session_respond_permission', {
      sessionId: SESSION,
      requestId: 'req-1',
      decision: { kind: 'deny', message: 'not that' },
    });
  });

  it('retires an answered card (the backend emits no resolution event)', async () => {
    mockBackend({ 0: { events: [[0, permission]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.respondPermission('req-1', { kind: 'allowOnce' });

    expect(liveSessionStore.pending).toEqual([]);
  });

  it('sends the exact answer-question payload the backend expects', async () => {
    const question: SessionEvent = {
      kind: 'questionRequest',
      requestId: 'q-1',
      questions: [
        { id: 'q1', header: 'Scope', text: 'How far?', options: [{ label: 'All' }], multiSelect: false },
      ],
    };
    mockBackend({ 0: { events: [[0, question]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);

    invoke.mockClear();
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.answerQuestion('q-1', [{ questionId: 'q1', values: ['All'] }]);

    expect(invoke).toHaveBeenCalledWith('agent_session_answer_question', {
      sessionId: SESSION,
      requestId: 'q-1',
      answers: [{ questionId: 'q1', values: ['All'] }],
    });
    expect(liveSessionStore.pending).toEqual([]);
  });

  it('sends, interrupts, and ends against the open session id', async () => {
    mockBackend({ 0: { events: [], nextSeq: 0, truncated: false } });
    await liveSessionStore.open(SESSION);

    invoke.mockClear();
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.send('hello');
    await liveSessionStore.interrupt();

    expect(invoke).toHaveBeenCalledWith('agent_session_send', {
      sessionId: SESSION,
      text: 'hello',
    });
    expect(invoke).toHaveBeenCalledWith('agent_session_interrupt', { sessionId: SESSION });
  });

  it('does not invoke at all when no session is open', async () => {
    await liveSessionStore.send('hello');
    await liveSessionStore.interrupt();
    await liveSessionStore.respondPermission('req-1', { kind: 'allowOnce' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('liveSessionStore.start', () => {
  it('passes the spec through under a `spec` key and opens what came back', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_start') return Promise.resolve({ sessionId: 'fresh' });
      if (command === 'agent_session_replay') {
        return Promise.resolve({ events: [], nextSeq: 0, truncated: false });
      }
      if (command === 'agent_session_list') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const spec = {
      sessionId: '',
      tool: 'claude',
      cwd: '',
      company: 'indigo',
      model: null,
      effort: null,
      resume: null,
      permissionMode: 'prompt',
    } as const;
    const id = await liveSessionStore.start({ ...spec });

    expect(id).toBe('fresh');
    expect(invoke).toHaveBeenCalledWith('agent_session_start', { spec: { ...spec } });
    expect(liveSessionStore.activeSessionId).toBe('fresh');
  });
});

describe('liveSessionStore.close', () => {
  it('drops the transcript and unlistens once nothing is open', async () => {
    mockBackend({ 0: { events: [[0, started]], nextSeq: 1, truncated: false } });
    await liveSessionStore.open(SESSION);

    liveSessionStore.close(SESSION);

    expect(liveSessionStore.activeSessionId).toBeNull();
    expect(liveSessionStore.events).toEqual([]);
    expect(unlistened).toEqual(
      expect.arrayContaining([AGENT_SESSION_EVENT, AGENT_SESSION_PHASE, AGENT_SESSION_NEEDS_YOU]),
    );
  });
});
