// @vitest-environment happy-dom

// The host half of #welcome's native setup run, over the real live session
// store with the Tauri bridges mocked: preflight gating, start = the same
// start+send a Sessions draft does, attach by id, snapshots that follow the
// event stream, and answers that reach the watched session even when the
// Sessions page has another one active.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../components/sessions/session-events';

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

import {
  AGENT_SESSION_EVENT,
  AGENT_SESSION_PHASE,
  liveSessionStore,
  resetLiveSessionStore,
  resetProbeCaches,
  type Preflight,
  type SessionSummary,
} from './live-session-store.svelte';
import { createSetupRunApi, setupRunTool } from './setup-run-host.svelte';

const SETUP = 'sess-setup';
const OTHER = 'sess-other';

function preflight(overrides: Partial<Preflight> = {}): Preflight {
  return {
    hqRoot: '/Users/x/HQ',
    hooksReady: true,
    hooksError: null,
    hqSetup: 'ready',
    claudeAvailable: true,
    claudeLoggedIn: true,
    codexAvailable: false,
    codexLoggedIn: false,
    grokAvailable: false,
    grokLoggedIn: false,
    companies: [],
    ...overrides,
  };
}

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    tool: 'claude',
    phase: 'working',
    company: null,
    model: 'opus',
    requestedModel: null,
    cwd: '/Users/x/HQ',
    startedAt: '2026-09-09T00:00:00.000Z',
    lastActivityAt: '2026-09-09T00:00:00.000Z',
    lastSeq: 0,
    pendingCount: 0,
    effort: null,
    permissionMode: 'prompt',
    ...overrides,
  };
}

interface Backend {
  list: SessionSummary[];
  preflight: Preflight;
  commands: string[];
  /** When set, the command probe rejects with this instead of answering. */
  commandsError?: Error;
}

function mockBackend(backend: Backend) {
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'agent_session_preflight':
        return Promise.resolve(backend.preflight);
      case 'agent_session_slash_commands':
        if (backend.commandsError) return Promise.reject(backend.commandsError);
        return Promise.resolve({ commands: backend.commands.map((name) => ({ name, description: name })), models: [{}] });
      case 'agent_session_list':
        return Promise.resolve(backend.list);
      case 'agent_session_replay':
        return Promise.resolve({ events: [], nextSeq: 0, truncated: false });
      case 'agent_session_start':
        return Promise.resolve({ sessionId: SETUP });
      default:
        return Promise.resolve(undefined);
    }
  });
  return backend;
}

function emit(sessionId: string, seq: number, event: SessionEvent) {
  handlers.get(AGENT_SESSION_EVENT)!({ payload: { sessionId, seq, receivedAtMs: 1, event } });
}

function calls(command: string) {
  return invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args as Record<string, unknown>);
}

beforeEach(() => {
  invoke.mockReset();
  handlers.clear();
  resetLiveSessionStore();
  resetProbeCaches();
});

afterEach(() => {
  resetLiveSessionStore();
  resetProbeCaches();
});

describe('setupRunTool', () => {
  it('prefers Claude, falls back to Codex, and refuses when HQ on this Mac is not ready', () => {
    expect(setupRunTool(preflight())).toBe('claude');
    expect(setupRunTool(preflight({ claudeLoggedIn: false, codexAvailable: true, codexLoggedIn: true }))).toBe('codex');
    expect(setupRunTool(preflight({ claudeLoggedIn: false }))).toBeNull();
    expect(setupRunTool(preflight({ hqSetup: 'needs_rescue' }))).toBeNull();
    expect(setupRunTool(preflight({ hqSetup: undefined as never, hooksReady: false }))).toBeNull();
  });
});

describe('createSetupRunApi', () => {
  it('preflight is ready only when a provider is signed in and /setup is in its catalog', async () => {
    const backend = mockBackend({ list: [], preflight: preflight(), commands: ['setup', 'handoff'] });
    const api = createSetupRunApi();
    expect(await api.preflight()).toBe('ready');

    resetProbeCaches();
    backend.commands = ['handoff'];
    expect(await api.preflight()).toBe('needs-sessions-page');

    resetProbeCaches();
    backend.commands = ['setup'];
    backend.preflight = preflight({ claudeLoggedIn: false });
    expect(await api.preflight()).toBe('needs-sessions-page');
  });

  it('preflight reports needs-sessions-page when the machine check itself fails', async () => {
    invoke.mockRejectedValue(new Error('bridge down'));
    expect(await createSetupRunApi().preflight()).toBe('needs-sessions-page');
  });

  it('preflight stays ready when only the command probe fails: the HQ layer is vouched for', async () => {
    const backend = mockBackend({ list: [], preflight: preflight(), commands: ['setup'] });
    backend.commandsError = new Error('Claude did not answer the command probe');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await createSetupRunApi().preflight()).toBe('ready');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('start launches a fresh session with the preflighted tool and sends the prompt', async () => {
    mockBackend({ list: [summary(SETUP)], preflight: preflight(), commands: ['setup'] });
    const api = createSetupRunApi();
    await api.preflight();
    const id = await api.start('/setup');
    expect(id).toBe(SETUP);
    const [start] = calls('agent_session_start');
    expect(start!.spec).toMatchObject({ sessionId: '', tool: 'claude', company: null, resume: null, permissionMode: 'prompt' });
    const [send] = calls('agent_session_send');
    expect(send).toMatchObject({ sessionId: SETUP, text: '/setup' });
    expect(liveSessionStore.activeSessionId).toBe(SETUP);
  });

  it('start honours the tool the person picked over what preflight chose', async () => {
    mockBackend({ list: [summary(SETUP)], preflight: preflight({ codexAvailable: true, codexLoggedIn: true }), commands: ['setup'] });
    const api = createSetupRunApi();
    await api.preflight();
    await api.start('/setup', 'codex');
    expect(calls('agent_session_start')[0]!.spec).toMatchObject({ tool: 'codex' });
  });

  it('attach re-opens a session the registry still lists and refuses one it does not', async () => {
    const backend = mockBackend({ list: [summary(SETUP)], preflight: preflight(), commands: ['setup'] });
    const api = createSetupRunApi();
    expect(await api.attach(SETUP)).toBe(true);
    expect(liveSessionStore.isOpen(SETUP)).toBe(true);
    expect(calls('agent_session_replay')[0]).toMatchObject({ sessionId: SETUP, sinceSeq: 0 });

    backend.list = [];
    expect(await api.attach('sess-gone')).toBe(false);
    expect(liveSessionStore.isOpen('sess-gone')).toBe(false);
  });

  it('subscribe fires at once and then follows the event stream and phase for that session only', async () => {
    mockBackend({ list: [summary(SETUP)], preflight: preflight(), commands: ['setup'] });
    const api = createSetupRunApi();
    await api.attach(SETUP);
    const seen: { kinds: string[]; phase: string; resolved: readonly string[] }[] = [];
    const stop = api.subscribe(SETUP, (snapshot) => {
      seen.push({
        kinds: snapshot.events.map((event) => event.kind),
        phase: snapshot.phase,
        resolved: snapshot.resolvedRequestIds ?? [],
      });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kinds: [], phase: 'working' });
    await Promise.resolve();

    emit(SETUP, 0, { kind: 'assistantMessage', text: 'Checking what is already in place.' });
    await Promise.resolve();
    emit(SETUP, 1, { kind: 'questionRequest', requestId: 'req-1', questions: [{ id: 'q1', header: 'Scope', text: 'Pick one?', options: [{ label: 'A' }], multiSelect: false }] });
    handlers.get(AGENT_SESSION_PHASE)!({ payload: { sessionId: SETUP, from: 'working', to: 'needsYou' } });
    await Promise.resolve();
    await Promise.resolve();
    const latest = seen[seen.length - 1]!;
    expect(latest.kinds).toEqual(['assistantMessage', 'questionRequest']);
    expect(latest.phase).toBe('needsYou');

    await api.answerQuestion(SETUP, 'req-1', [{ questionId: 'q1', values: ['A'] }]);
    await Promise.resolve();
    expect(calls('agent_session_answer_question')[0]).toMatchObject({
      sessionId: SETUP,
      requestId: 'req-1',
      answers: [{ questionId: 'q1', values: ['A'] }],
    });
    expect(seen[seen.length - 1]!.resolved).toEqual(['req-1']);

    // A different session's events never reach this subscriber.
    emit(OTHER, 0, { kind: 'assistantMessage', text: 'unrelated' });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[seen.length - 1]!.kinds).toEqual(['assistantMessage', 'questionRequest']);
    stop();
  });

  it('send and permission answers target the watched session even when another is active', async () => {
    mockBackend({ list: [summary(SETUP), summary(OTHER)], preflight: preflight(), commands: ['setup'] });
    const api = createSetupRunApi();
    await api.attach(SETUP);
    await liveSessionStore.open(OTHER);
    expect(liveSessionStore.activeSessionId).toBe(OTHER);

    await api.send(SETUP, 'Jacob');
    expect(calls('agent_session_send')[0]).toMatchObject({ sessionId: SETUP, text: 'Jacob' });

    await api.respondPermission(SETUP, 'perm-1', 'allowSession');
    expect(calls('agent_session_respond_permission')[0]).toMatchObject({
      sessionId: SETUP,
      requestId: 'perm-1',
      decision: { kind: 'allowSession' },
    });
    await api.respondPermission(SETUP, 'perm-2', 'deny');
    expect(calls('agent_session_respond_permission')[1]).toMatchObject({
      sessionId: SETUP,
      decision: { kind: 'deny', message: 'Not now' },
    });
    expect(liveSessionStore.resolvedRequestIdsOf(SETUP)).toEqual(['perm-1', 'perm-2']);
  });

  it('providers reports what preflight knows and login calls pass straight through', async () => {
    mockBackend({ list: [], preflight: preflight({ claudeLoggedIn: false, codexAvailable: true, codexLoggedIn: true }), commands: ['setup'] });
    const api = createSetupRunApi();
    expect(await api.providers!()).toEqual({
      hqReady: true,
      claudeAvailable: true,
      claudeLoggedIn: false,
      codexAvailable: true,
      codexLoggedIn: true,
    });
    expect(api.providerInstallUrl!('claude')).toContain('claude.ai');
    invoke.mockResolvedValueOnce({ state: 'waiting' });
    expect(await api.providerLoginStart!('claude')).toEqual({ state: 'waiting' });
    expect(calls('agent_provider_login_start')[0]).toEqual({ tool: 'claude' });
  });

  it('storeSecret hands the value to the Rust side only, never to the session', async () => {
    mockBackend({ list: [summary(SETUP)], preflight: preflight(), commands: ['setup'] });
    const api = createSetupRunApi();
    await api.attach(SETUP);
    await api.storeSecret!({ kind: 'secret', name: 'DATABASE_URL', scope: 'company', company: 'hqtestco' }, 'postgres://x');
    expect(calls('setup_store_secret')[0]).toEqual({
      name: 'DATABASE_URL',
      scope: 'company',
      company: 'hqtestco',
      value: 'postgres://x',
    });
    expect(calls('agent_session_send')).toHaveLength(0);
    await api.storeSecret!({ kind: 'secret', name: 'TOKEN', scope: 'personal' }, 'abc');
    expect(calls('setup_store_secret')[1]).toMatchObject({ scope: 'personal', company: null });
  });
});
