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
  resetProbeCaches,
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
    requestedModel: null,
    cwd: '/Users/x/HQ',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    lastSeq: 0,
    pendingCount: 0,
    effort: null,
    permissionMode: 'prompt',
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
type ReplayPage = {
  events: { seq: number; receivedAtMs: number; event: SessionEvent }[];
  nextSeq: number;
  truncated: boolean;
};

/** A fixed backend clock, so a stamp assertion is about the plumbing. */
const T0 = Date.parse('2026-09-02T14:00:00.000Z');

/** `[seq, event]` shorthand → the entry shape the backend actually returns. */
function page(
  pairs: [number, SessionEvent][],
  nextSeq: number,
  truncated = false,
): ReplayPage {
  return {
    events: pairs.map(([seq, event]) => ({ seq, receivedAtMs: T0 + seq * 1000, event })),
    nextSeq,
    truncated,
  };
}

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

/** The assistant prose the transcript would render, oldest first. */
function proseText(): string[] {
  return liveSessionStore.transcript.blocks
    .filter((block) => block.type === 'assistantProse')
    .map((block) => (block as { text: string }).text);
}

/** The operator bubbles the transcript would render, oldest first. */
function bubbleText(): string[] {
  return liveSessionStore.transcript.blocks
    .filter((block) => block.type === 'userBubble')
    .map((block) => (block as { text: string }).text);
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
      0: page([[0, started]], 1),
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
    // The fold is what the transcript renders. `started` is deliberately NOT a
    // row — the strip already names the session — so the only block is the
    // assistant's own prose.
    expect(proseText()).toEqual(['on it']);
  });

  it('carries the started event’s slash commands', async () => {
    mockBackend({ 0: page([[0, started]], 1) });
    await liveSessionStore.open(SESSION);
    expect(liveSessionStore.startedCommands.map((c) => c.name)).toEqual(['handoff']);
  });

  it('ignores an event for a session it does not have open', async () => {
    mockBackend({ 0: page([[0, started]], 1) });
    await liveSessionStore.open(SESSION);

    emit(AGENT_SESSION_EVENT, {
      sessionId: 'someone-else',
      seq: 0,
      event: { kind: 'assistantMessage', text: 'not mine' } satisfies SessionEvent,
    });

    expect(liveSessionStore.events).toHaveLength(1);
  });

  it('drops a duplicate event rather than folding it twice', async () => {
    mockBackend({ 0: page([[0, started]], 1) });
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
      0: page([[0, started]], 1),
      1: page([
          [1, missed],
          [2, arrived],
        ], 3),
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
    expect(proseText()).toEqual(['missed', 'arrived']);
  });
});

describe('liveSessionStore phase + needs-you', () => {
  it('updates the phase and refreshes the session list on a phase event', async () => {
    mockBackend({ 0: page([], 0) });
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
    mockBackend({ 0: page([], 0) });
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
    mockBackend({ 0: page([[0, permission]], 1) });
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
    mockBackend({ 0: page([[0, permission]], 1) });
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
    mockBackend({ 0: page([[0, question]], 1) });
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
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);

    invoke.mockClear();
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.send('hello');
    await liveSessionStore.interrupt();

    expect(invoke).toHaveBeenCalledWith('agent_session_send', {
      sessionId: SESSION,
      text: 'hello',
      images: [],
      overrides: null,
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
        return Promise.resolve(page([], 0));
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
    mockBackend({ 0: page([[0, started]], 1) });
    await liveSessionStore.open(SESSION);

    liveSessionStore.close(SESSION);

    expect(liveSessionStore.activeSessionId).toBeNull();
    expect(liveSessionStore.events).toEqual([]);
    expect(unlistened).toEqual(
      expect.arrayContaining([AGENT_SESSION_EVENT, AGENT_SESSION_PHASE, AGENT_SESSION_NEEDS_YOU]),
    );
  });
});


describe('liveSessionStore receivedAt stamps', () => {
  it('takes a live event\u2019s stamp from the backend, not from its own clock', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);

    emit(AGENT_SESSION_EVENT, {
      sessionId: SESSION,
      seq: 0,
      receivedAtMs: T0,
      event: { kind: 'assistantMessage', text: 'live' } satisfies SessionEvent,
    });

    expect(liveSessionStore.receivedAt).toEqual([T0]);
  });

  it('falls back to now for a payload that carries no stamp', async () => {
    // Defensive: an older backend emits no `receivedAtMs`. Guessing "now" is
    // wrong by less than dropping the event\u2019s date entirely.
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);

    const before = Date.now();
    emit(AGENT_SESSION_EVENT, {
      sessionId: SESSION,
      seq: 0,
      event: { kind: 'assistantMessage', text: 'live' } satisfies SessionEvent,
    });
    const after = Date.now();

    const [stamp] = liveSessionStore.receivedAt;
    expect(stamp).not.toBeNull();
    expect(stamp!).toBeGreaterThanOrEqual(before);
    expect(stamp!).toBeLessThanOrEqual(after);
  });

  it('dates a REPLAYED event by when the backend recorded it', async () => {
    // The gap this closes: replayed events used to carry no time at all, so a
    // reopened transcript could not tell yesterday from a minute ago. The
    // backend now stamps every buffered event, and the fold uses that instant.
    mockBackend({
      0: page([
          [0, started],
          [1, { kind: 'assistantMessage', text: 'old' }],
        ], 2),
    });
    await liveSessionStore.open(SESSION);

    expect(liveSessionStore.receivedAt).toEqual([T0, T0 + 1000]);
    const prose = liveSessionStore.transcript.blocks.find((b) => b.type === 'assistantProse');
    expect(prose?.at).toBe(T0 + 1000);
  });

  it('treats a stampless replay entry as unknown rather than as now', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_list') return Promise.resolve([summary()]);
      if (command === 'agent_session_replay') {
        // An older backend: `(seq, event)` with no stamp at all.
        return Promise.resolve({
          events: [{ seq: 0, event: { kind: 'assistantMessage', text: 'old' } }],
          nextSeq: 1,
          truncated: false,
        });
      }
      return Promise.resolve(undefined);
    });

    await liveSessionStore.open(SESSION);

    expect(liveSessionStore.receivedAt).toEqual([null]);
    expect(liveSessionStore.transcript.blocks.some((b) => b.type === 'divider')).toBe(false);
  });

  it('keeps the stamps parallel to the events across a gap replay', async () => {
    const arrived: SessionEvent = { kind: 'assistantMessage', text: 'arrived' };
    mockBackend({
      0: page([[0, started]], 1),
      1: page([
          [1, { kind: 'assistantMessage', text: 'missed' }],
          [2, arrived],
        ], 3),
    });
    await liveSessionStore.open(SESSION);
    emit(AGENT_SESSION_EVENT, { sessionId: SESSION, seq: 2, event: arrived });
    await vi.waitFor(() => expect(liveSessionStore.nextSeq).toBe(3));

    expect(liveSessionStore.receivedAt).toHaveLength(liveSessionStore.events.length);
  });
});

describe('liveSessionStore mirrors the operator\'s own turns', () => {
  it('shows a sent message immediately, before the backend has echoed it', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.send('do the thing');

    expect(bubbleText()).toEqual(['do the thing']);
  });

  it('hands the bubble over to the backend\u2019s own userMessage instead of doubling it', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.send('do the thing');
    expect(bubbleText()).toEqual(['do the thing']);

    // The backend records the turn as it writes it to the CLI. Rendering both
    // copies would show every message twice.
    emit(AGENT_SESSION_EVENT, {
      sessionId: SESSION,
      seq: 0,
      receivedAtMs: T0,
      event: { kind: 'userMessage', text: 'do the thing', imageCount: 0 } satisfies SessionEvent,
    });

    expect(bubbleText()).toEqual(['do the thing']);
    expect(liveSessionStore.userTurns).toEqual([]);
  });

  it('rebuilds the operator\u2019s half of the conversation from a replay alone', async () => {
    // The gap this closes: a reopened session used to show the agent answering
    // questions nobody could see having been asked.
    mockBackend({
      0: page([
          [0, started],
          [1, { kind: 'userMessage', text: 'do the thing', imageCount: 1 }],
          [2, { kind: 'assistantMessage', text: 'on it' }],
        ], 3),
    });

    await liveSessionStore.open(SESSION);

    expect(liveSessionStore.transcript.blocks.map((block) => block.type)).toEqual([
      'userBubble',
      'assistantProse',
    ]);
    expect(bubbleText()).toEqual(['do the thing']);
  });

  it('prefers the replayed turn over a mirror of the same send', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.send('do the thing');

    // Exactly what a route change does — and this time the backend has the
    // turn, so the mirror must stand down rather than stack.
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_list') return Promise.resolve([summary()]);
      if (command === 'agent_session_replay') {
        return Promise.resolve(
          page([[0, { kind: 'userMessage', text: 'do the thing', imageCount: 0 }]], 1),
        );
      }
      return Promise.resolve(undefined);
    });
    liveSessionStore.close(SESSION);
    await liveSessionStore.open(SESSION);

    expect(bubbleText()).toEqual(['do the thing']);
  });

  it('SURVIVES the close/open pair a route change performs', async () => {
    // This is the whole point of keeping the mirror outside the session entry:
    // the first send is followed by a navigation, the page remounts, and the
    // message the user just sent has to still be on screen.
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_list') return Promise.resolve([summary()]);
      if (command === 'agent_session_replay') {
        return Promise.resolve(page([], 0));
      }
      return Promise.resolve(undefined);
    });
    await liveSessionStore.send('do the thing');

    liveSessionStore.close(SESSION);
    expect(bubbleText()).toEqual([]);

    await liveSessionStore.open(SESSION);
    expect(bubbleText()).toEqual(['do the thing']);
  });

  it('interleaves the bubble above the reply it provoked', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);
    await liveSessionStore.send('do the thing');

    emit(AGENT_SESSION_EVENT, {
      sessionId: SESSION,
      seq: 0,
      event: { kind: 'assistantMessage', text: 'on it' } satisfies SessionEvent,
    });

    expect(liveSessionStore.transcript.blocks.map((block) => block.type)).toEqual([
      'userBubble',
      'assistantProse',
    ]);
  });

  it('carries images on the send', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockClear();
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.send('what is this?', [
      { mediaType: 'image/png', base64: 'QUJD' },
    ]);

    expect(invoke).toHaveBeenCalledWith('agent_session_send', {
      sessionId: SESSION,
      text: 'what is this?',
      images: [{ mediaType: 'image/png', base64: 'QUJD' }],
      overrides: null,
    });
  });

  it('carries the moved model / effort pills on the SAME session', async () => {
    // The bug this pins: selecting a new thinking mode started a new chat.
    // Only a company change forks; model and effort ride the next turn.
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockClear();
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.send('again', [], { model: 'gpt-5.6-codex', effort: 'high' });

    expect(invoke).toHaveBeenCalledWith('agent_session_send', {
      sessionId: SESSION,
      text: 'again',
      images: [],
      overrides: { model: 'gpt-5.6-codex', effort: 'high' },
    });
    expect(
      invoke.mock.calls.some(([command]) => command === 'agent_session_start'),
      'a pill change must never start a session',
    ).toBe(false);
  });

  it('moves the permission pill on the live session rather than forking it', async () => {
    mockBackend({ 0: page([], 0) });
    await liveSessionStore.open(SESSION);
    invoke.mockClear();
    invoke.mockResolvedValue([]);

    await liveSessionStore.setPermissionMode('bypassAll');

    expect(invoke).toHaveBeenCalledWith('agent_session_set_permission_mode', {
      sessionId: SESSION,
      mode: 'bypassAll',
    });
    expect(
      invoke.mock.calls.some(([command]) => command === 'agent_session_start'),
    ).toBe(false);
  });
});

describe('liveSessionStore.startAndSend', () => {
  function mockStart(onStart?: () => void) {
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_start') {
        onStart?.();
        return Promise.resolve({ sessionId: 'fresh' });
      }
      if (command === 'agent_session_replay') {
        return Promise.resolve(page([], 0));
      }
      if (command === 'agent_session_list') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  }

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

  it('starts the session the first message belongs to, then sends it', async () => {
    mockStart();
    const id = await liveSessionStore.startAndSend({ ...spec }, 'hello');

    expect(id).toBe('fresh');
    expect(invoke).toHaveBeenCalledWith('agent_session_start', { spec: { ...spec } });
    expect(invoke).toHaveBeenCalledWith('agent_session_send', {
      sessionId: 'fresh',
      text: 'hello',
      images: [],
      overrides: null,
    });
    expect(liveSessionStore.activeSessionId).toBe('fresh');
    expect(bubbleText()).toEqual(['hello']);
  });

  it('paints the bubble BEFORE the backend has minted an id', async () => {
    let duringStart: string[] = [];
    mockStart(() => {
      duringStart = bubbleText();
    });
    await liveSessionStore.startAndSend({ ...spec }, 'hello');
    expect(duringStart).toEqual(['hello']);
  });

  it('takes the bubble back when the start fails — it would be a lie', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_session_start') return Promise.reject(new Error('no CLI'));
      return Promise.resolve(undefined);
    });

    await expect(liveSessionStore.startAndSend({ ...spec }, 'hello')).rejects.toThrow('no CLI');
    expect(bubbleText()).toEqual([]);
  });

  it('keeps the bubble across the remount that follows the first send', async () => {
    mockStart();
    const id = await liveSessionStore.startAndSend({ ...spec }, 'hello');
    // Exactly what the page does on the route change: close, then reopen.
    liveSessionStore.close(id);
    await liveSessionStore.open(id);
    expect(bubbleText()).toEqual(['hello']);
  });
});

describe('liveSessionStore resolutions', () => {
  const permission: SessionEvent = {
    kind: 'permissionRequest',
    requestId: 'req-1',
    toolName: 'Write',
    input: { file_path: 'hello.txt' },
    suggestions: [],
  };

  it('records the verb so an answered card collapses instead of vanishing', async () => {
    mockBackend({ 0: page([[0, permission]], 1) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.respondPermission('req-1', { kind: 'allowSession' });

    const card = liveSessionStore.transcript.blocks.find((b) => b.type === 'permissionCard');
    expect(card).toBeDefined();
    expect((card as { resolution: string | null }).resolution).toBe('Allowed for session');
    expect(liveSessionStore.pending).toEqual([]);
  });

  it('records a denial as a denial', async () => {
    mockBackend({ 0: page([[0, permission]], 1) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.respondPermission('req-1', { kind: 'deny', message: 'no' });

    const card = liveSessionStore.transcript.blocks.find((b) => b.type === 'permissionCard');
    expect((card as { resolution: string | null }).resolution).toBe('Denied');
  });

  it('summarises the chosen answers on a question card', async () => {
    const question: SessionEvent = {
      kind: 'questionRequest',
      requestId: 'q-1',
      questions: [
        { id: 'q1', header: 'Scope', text: 'How far?', options: [{ label: 'All' }], multiSelect: false },
      ],
    };
    mockBackend({ 0: page([[0, question]], 1) });
    await liveSessionStore.open(SESSION);
    invoke.mockResolvedValue(undefined);

    await liveSessionStore.answerQuestion('q-1', [{ questionId: 'q1', values: ['All'] }]);

    const card = liveSessionStore.transcript.blocks.find((b) => b.type === 'questionCard');
    expect((card as { resolution: string | null }).resolution).toBe('Answered · All');
  });
});

describe('liveSessionStore.lastUsage', () => {
  it('surfaces the last turn cost for the composer footer', async () => {
    mockBackend({
      0: page([[0, { kind: 'usage', inputTokens: 2, outputTokens: 17, costUsd: 0.68 }]], 1),
    });
    await liveSessionStore.open(SESSION);
    expect(liveSessionStore.lastUsage?.label).toBe('2 in · 17 out · $0.68');
  });
});

describe('probe memoization (preflight + catalog)', () => {
  beforeEach(() => {
    resetLiveSessionStore();
    resetProbeCaches();
    invoke.mockReset();
  });

  it('runs the preflight probe once per window, not once per page mount', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_session_preflight') {
        return { hqRoot: '/hq', hooksReady: true, hooksError: null, claudeAvailable: true,
          claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, companies: [] };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await liveSessionStore.preflight();
    await liveSessionStore.preflight();
    const calls = invoke.mock.calls.filter(([cmd]) => cmd === 'agent_session_preflight');
    expect(calls).toHaveLength(1);
  });

  it('spawns the catalog probe once for the process lifetime, and retries only after a failure', async () => {
    let attempts = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== 'agent_session_slash_commands') throw new Error(`unexpected ${cmd}`);
      attempts += 1;
      if (attempts === 1) throw new Error('probe failed');
      return { commands: [], models: [] };
    });
    await expect(liveSessionStore.slashCommands('claude')).rejects.toThrow('probe failed');
    await liveSessionStore.slashCommands('claude');
    await liveSessionStore.slashCommands('claude');
    expect(attempts).toBe(2);
    resetProbeCaches();
    await liveSessionStore.slashCommands('claude');
    expect(attempts).toBe(3);
  });
});
